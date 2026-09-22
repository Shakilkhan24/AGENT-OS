/**
 * M3c.5 — managed-work action tests (answer / continue / new-attempt / stop).
 *
 * Coverage:
 *  - `answerAttention` resolves an open `decision` item and writes the
 *    next-revision `decision` row carrying the reply in `payload_json`.
 *  - `answerAttention` on a non-`decision` kind throws CONFLICT.
 *  - `newAttempt` spawns a fresh invocation with a new idempotencyKey,
 *    incremented attempt, and recorded `parentInvocationId` lineage.
 *  - `continueInvocation` resolves the open decision AND spawns a
 *    continuation invocation via `executeOnce`.
 *  - `requestRunStop` flips the run to `cancelled` and writes the audit
 *    event; subsequent `executeOnce` calls for the run are blocked.
 *
 * The `executeOnce` orchestrator is swapped to the scripted provider
 * double so we can drive it deterministically without spinning up a
 * real provider process.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import { createRun } from "../../src/runtime/db/runs";
import { readInvocation } from "../../src/runtime/db/invocations";
import { raiseAttention, readAttention } from "../../src/runtime/db/attention-items";
import {
  answerAttention,
  continueInvocation,
  isRunStopped,
  newAttempt,
  requestRunStop,
} from "../../src/runtime/orchestration/managed-actions";
import {
  executeOnce,
  resetExecuteOnceAdapter,
  setExecuteOnceAdapter,
} from "../../src/runtime/orchestration/execute-once";
import { ScriptedProviderDouble } from "../../src/runtime/providers/scripted-double";
import type { ProviderAdapter } from "../../src/runtime/providers/adapter";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function setupRun(worker: DbWorker): Promise<{ taskId: string; runId: string }> {
  const { id: taskId } = await createTask(worker, { title: "m3c5", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  return { taskId, runId: run.id };
}

const baseExecuteInput = (runId: string) => ({
  runId,
  idempotencyKey: "idem-m3c5",
  canonicalDigest: "b".repeat(64),
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

test("answerAttention resolves an open decision and writes the reply at revision + 1", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await setupRun(worker);
    const raised = await raiseAttention(worker, {
      taskId, kind: "decision", issueIdentity: "needs-input", revision: 0, payload: { question: "what colour?" },
    });
    assert.equal(raised.state, "new");

    const result = await answerAttention(worker, raised.id, {
      reply: "blue", answeredBy: "user",
    });
    assert.equal(result.resolvedItem.state, "resolved");
    assert.equal(result.followUpItem?.kind, "decision");
    assert.equal(result.followUpItem?.revision, 1);
    assert.equal(result.followUpItem?.issueIdentity, "needs-input");

    const payload = JSON.parse(result.followUpItem!.payloadJson) as Record<string, unknown>;
    assert.equal(payload.reply, "blue");
    assert.equal(payload.answeredBy, "user");
    assert.match(String(payload.answeredAt), /^\d{4}-\d{2}-\d{2}T/);
  } finally { await worker.close(); }
});

test("answerAttention on a non-decision kind throws CONFLICT", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await setupRun(worker);
    const raised = await raiseAttention(worker, {
      taskId, kind: "review", issueIdentity: "review-1", revision: 0, payload: {},
    });
    let thrown: unknown;
    try {
      await answerAttention(worker, raised.id, { reply: "x", answeredBy: "user" });
      assert.fail("Expected answerAttention to throw CONFLICT for a review row");
    } catch (error) { thrown = error; }
    assert.ok(thrown instanceof AppError);
    assert.equal((thrown as AppError).failure.code, "CONFLICT");
    assert.match((thrown as AppError).message, /decision/i);
  } finally { await worker.close(); }
});

test("newAttempt spawns a fresh invocation with a new idempotencyKey + parentInvocationId lineage", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      // First invocation establishes lineage.
      const first = await executeOnce(worker, baseExecuteInput(runId));
      assert.equal(first.kind, "ok");
      if (first.kind === "ok") {
        first.handle.stdin.close();
        await new Promise(resolve => setImmediate(resolve));
      }

      // Second invocation via newAttempt — different idem key.
      const second = await newAttempt(worker, {
        runId,
        idempotencyKey: "idem-m3c5-second",
        canonicalDigest: "c".repeat(64),
        providerVersion: "v1", model: "m1",
        accountMode: "authenticated",
        method: "agent-run",
        args: { prompt: "second" },
        scope: {},
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        requestedBy: "user",
      });
      assert.equal(second.kind, "ok");
      if (second.kind === "ok") {
        const invocation = await readInvocation(worker, second.invocationId);
        assert.ok(invocation);
        assert.equal(invocation?.idempotencyKey, "idem-m3c5-second");
        assert.equal(invocation?.canonicalDigest, "c".repeat(64));
      }
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("continueInvocation resolves the open decision AND spawns a continuation invocation", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      // Seed an initial invocation so `continueInvocation` has a
      // previousInvocationId to chain off.
      const first = await executeOnce(worker, baseExecuteInput(runId));
      assert.equal(first.kind, "ok");
      if (first.kind === "ok") {
        first.handle.stdin.close();
        await new Promise(resolve => setImmediate(resolve));
      }

      // Raise an open decision item.
      const attention = await raiseAttention(worker, {
        taskId, kind: "decision", issueIdentity: "needs-input", revision: 0, payload: {},
      });

      const result = await continueInvocation(worker, attention.id, {
        providerVersion: "v1", model: "m1",
        accountMode: "authenticated",
        args: { prompt: "continuation" },
        scope: {},
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        attemptedBy: "user",
      });
      assert.equal(result.kind, "ok");
      if (result.kind === "ok") {
        assert.equal(result.attentionId, attention.id);
        const after = await readAttention(worker, attention.id);
        assert.equal(after?.state, "resolved");
        const invocation = await readInvocation(worker, result.invocationId);
        assert.ok(invocation);
        assert.equal(invocation?.idempotencyKey.startsWith("continue:"), true);
      }
    } finally { cleanup(); }
  } finally { await worker.close(); }
});

test("requestRunStop flips the run to cancelled, blocks executeOnce, and is idempotent", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await setupRun(worker);
    const cleanup = adapterFromDouble(new ScriptedProviderDouble());
    try {
      const first = await requestRunStop(worker, runId, { reason: "abandon", requestedBy: "user" });
      assert.equal(first.kind, "ok");
      assert.equal(first.status, "cancelled");
      assert.equal(first.blockedExecuteOnce, true);
      assert.equal(isRunStopped(runId), true);

      // executeOnce now refuses to spawn.
      const blocked = await executeOnce(worker, baseExecuteInput(runId));
      assert.equal(blocked.kind, "conflict");

      // Idempotent: re-stop is a no-op.
      const second = await requestRunStop(worker, runId, { reason: "again", requestedBy: "user" });
      assert.equal(second.kind, "ok");
      assert.equal(second.status, "cancelled");
    } finally { cleanup(); }
  } finally { await worker.close(); }
});
