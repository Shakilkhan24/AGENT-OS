/**
 * M3b.2 — execute-once orchestrator tests.
 *
 * Coverage:
 *  - First dispatch produces an invocation, a recorded→claimed→spawned
 *    dispatch_intent trail, and a working handle.
 *  - A second dispatch with the same `(runId, idempotencyKey)` returns the
 *    original invocation in `error` (terminal) rather than re-spawning.
 *  - Replay with a different canonical digest raises CONFLICT.
 *  - The scripted provider's `disconnectOnFirstWrite` reaches
 *    `markAmbiguous`, transitions the invocation to `error`, and writes
 *    a `dispatch.ambiguous` audit event.
 *
 * The orchestrator's adapter is swapped via the `setExecuteOnceAdapter`
 * test seam so the scripted double (deterministic) is the only thing
 * under test.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { SqliteDatabase, hasSqliteBuiltin } from "../../../src/runtime/db/sqlite";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun } from "../../../src/runtime/db/runs";
import { createInvocation, readInvocation } from "../../../src/runtime/db/invocations";
import { listDispatchIntentsForRun } from "../../../src/runtime/db/dispatch-intents";
import {
  executeOnce,
  resetExecuteOnceAdapter,
  setExecuteOnceAdapter,
} from "../../../src/runtime/orchestration/execute-once";
import { ScriptedProviderDouble } from "../../../src/runtime/providers/scripted-double";
import type { ProviderAdapter } from "../../../src/runtime/providers/adapter";
import { AppError } from "../../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function setupRun(worker: DbWorker): Promise<string> {
  const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  return run.id;
}

const baseInput = (runId: string) => ({
  runId,
  idempotencyKey: "idem-1",
  canonicalDigest: "a".repeat(64),
  providerVersion: "v1",
  model: "m1",
  accountMode: "authenticated" as const,
  method: "agent-run",
  args: { prompt: "hello" },
  scope: { restrictions: [] },
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  parentInvocationId: null,
  revision: null,
});

function adapterFromDouble(double: ProviderAdapter) {
  setExecuteOnceAdapter(() => double);
  return () => resetExecuteOnceAdapter();
}

// Concurrent-dispatch isolation is enforced by SQLite's BEGIN IMMEDIATE
// semantics; the in-process MemoryDatabase is a test-only fallback that
// does not provide cross-handle isolation. Skip when the runtime is Node
// < 22.5 (no built-in `node:sqlite`).
const sqliteRequired = hasSqliteBuiltin() ? test : test.skip;

for (const existing of [false, true]) sqliteRequired(`concurrent dispatch is exclusive with a ${existing ? "persisted pending" : "new"} invocation`, async () => {
  const driver = new SqliteDatabase(":memory:");
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  const worker = new DbWorker({ driver });
  const double = new ScriptedProviderDouble();
  const handles: Awaited<ReturnType<ProviderAdapter["spawn"]>>[] = [];
  let spawns = 0;
  setExecuteOnceAdapter(() => ({
    kind: "scripted", capabilities: () => double.capabilities(),
    async spawn(req) {
      spawns++;
      await new Promise(resolve => setTimeout(resolve, 20));
      const handle = await double.spawn(req); handles.push(handle); return handle;
    },
  }));
  try {
    const input = baseInput(await setupRun(worker));
    if (existing) await createInvocation(worker, {
      runId: input.runId, idempotencyKey: input.idempotencyKey, canonicalDigest: input.canonicalDigest,
      providerVersion: input.providerVersion, model: input.model, accountMode: input.accountMode,
    });
    const results = await Promise.allSettled([executeOnce(worker, input), executeOnce(worker, input)]);
    assert.equal(spawns, 1, "the durable claim must precede the external spawn");
    assert.ok(results.every(result => result.status === "fulfilled"), "a matching retry must not fail with SQL uniqueness errors");
    assert.equal((await listDispatchIntentsForRun(worker, input.runId)).length, 1);
  } finally {
    handles.forEach(handle => handle.stdin.close());
    resetExecuteOnceAdapter(); await worker.close();
  }
});

test("an adapter spawn error leaves a durable claim and cannot be retried as a new spawn", async () => {
  const worker = freshWorker();
  let spawns = 0;
  setExecuteOnceAdapter(() => ({ kind: "scripted", capabilities: () => new ScriptedProviderDouble().capabilities(),
    async spawn() { spawns++; throw new Error("spawn acknowledgement lost"); } }));
  try {
    const input = baseInput(await setupRun(worker));
    const first = await executeOnce(worker, input);
    const retry = await executeOnce(worker, input);
    assert.equal(first.kind, "ambiguous");
    assert.equal(retry.kind, "ambiguous");
    assert.equal(spawns, 1);
  } finally { resetExecuteOnceAdapter(); await worker.close(); }
});

test("first dispatch lands invocation through admitted → spawned and yields a working handle", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      const result = await executeOnce(worker, baseInput(runId));
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.ok(result.handle.startup);
        // Close stdin so the handle emits its exit.
        result.handle.stdin.close();
        await new Promise(resolve => setImmediate(resolve));
        const invocation = await readInvocation(worker, result.invocationId);
        assert.equal(invocation?.status, "spawned");
      }
      const intents = await listDispatchIntentsForRun(worker, runId);
      assert.equal(intents.length, 1);
      assert.equal(intents[0]?.state, "spawned");
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("replay with same idempotency + matching digest returns the existing invocation (rehydrated)", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      const first = await executeOnce(worker, baseInput(runId));
      assert.equal(first.kind, "ok");
      if (first.kind === "ok") {
        // Replay — same digest and idem key. The orchestrator's
        // createInvocation returns the original (now spawned), and the
        // orchestrator surfaces the replay as `ok` with `rehydrated: true`
        // (no second adapter process).
        const second = await executeOnce(worker, baseInput(runId));
        assert.equal(second.kind, "ok");
        if (second.kind === "ok") {
          assert.equal(second.invocationId, first.invocationId);
          assert.equal(second.rehydrated, true);
        }
        first.handle.stdin.close();
      }
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("different digest on the same idempotency key raises CONFLICT", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      const first = await executeOnce(worker, baseInput(runId));
      if (first.kind === "ok") first.handle.stdin.close();
      await assert.rejects(
        executeOnce(worker, { ...baseInput(runId), canonicalDigest: "b".repeat(64) }),
        (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
      );
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("disconnect before first ack reaches markAmbiguous, invocation becomes error", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble({ disconnectOnFirstWrite: true }));
    try {
      const result = await executeOnce(worker, baseInput(runId));
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        // Wait for the disconnect cycle.
        await new Promise(resolve => setImmediate(resolve));
        await new Promise(resolve => setImmediate(resolve));
        const invocation = await readInvocation(worker, result.invocationId);
        assert.equal(invocation?.status, "error");
        assert.equal(invocation?.endedReason, "ambiguous-dispatch");
        // A second executeOnce for the same idem key returns ambiguous
        // rather than re-spawning.
        const second = await executeOnce(worker, baseInput(runId));
        assert.equal(second.kind, "ambiguous");
      }
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("createInvocation is exercised directly as a sanity check (no dependency on the orchestrator)", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRun(worker);
    const invocation = await createInvocation(worker, {
      runId, idempotencyKey: "alone", canonicalDigest: "c".repeat(64),
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    assert.equal(invocation.canonicalDigest, "c".repeat(64));
  } finally { await worker.close(); }
});
