/**
 * M3b.2 — observation log tests.
 *
 * Coverage:
 *  - `recordObservation` writes a `provider.observation` event with the
 *    supplied payload and assigns a fresh, monotonic `seq`.
 *  - Multiple observations against the same invocation produce distinct,
 *    monotonically increasing seqs.
 *  - The payload schema refuses startup/exit/usage shapes that are
 *    missing required fields.
 *  - A missing invocation reference raises NOT_FOUND.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun } from "../../../src/runtime/db/runs";
import { createInvocation } from "../../../src/runtime/db/invocations";
import { recordObservation } from "../../../src/runtime/orchestration/observation";
import { AppError } from "../../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function setupInvocation(worker: DbWorker): Promise<string> {
  const { id: taskId } = await createTask(worker, { title: "obs task", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  const invocation = await createInvocation(worker, {
    runId: run.id,
    idempotencyKey: "obs-key",
    canonicalDigest: "a".repeat(64),
    providerVersion: "v1",
    model: "m1",
    accountMode: "authenticated",
  });
  return invocation.id;
}

test("recordObservation writes a provider.observation event with a fresh seq", async () => {
  const worker = freshWorker();
  try {
    const invocationId = await setupInvocation(worker);
    const { seq } = await recordObservation(worker, {
      invocationId,
      correlationId: invocationId,
      payload: {
        startup: { kind: "scripted-double", correlationId: invocationId },
        exit: { at: new Date().toISOString(), code: 0, signal: null, reason: null },
        usage: null,
      },
    });
    assert.ok(seq >= 1);
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare("SELECT * FROM event WHERE seq = ?").first(seq);
    assert.equal(row?.type, "provider.observation");
    const payload = JSON.parse(String(row?.payload_json));
    assert.equal(payload.startup.kind, "scripted-double");
    assert.equal(payload.exit.code, 0);
  } finally { await worker.close(); }
});

test("two observations produce monotonically increasing seqs", async () => {
  const worker = freshWorker();
  try {
    const invocationId = await setupInvocation(worker);
    const a = await recordObservation(worker, {
      invocationId, correlationId: invocationId,
      payload: { startup: {}, exit: { at: new Date().toISOString(), code: 0, signal: null, reason: null }, usage: null },
    });
    const b = await recordObservation(worker, {
      invocationId, correlationId: invocationId,
      payload: { startup: {}, exit: { at: new Date().toISOString(), code: 0, signal: null, reason: null }, usage: null },
    });
    console.log("a.seq:", a.seq, "b.seq:", b.seq);
    assert.ok(b.seq > a.seq, `expected b.seq > a.seq, got a=${a.seq}, b=${b.seq}`);
  } finally { await worker.close(); }
});

test("recordObservation refuses payloads with missing required exit fields", async () => {
  const worker = freshWorker();
  try {
    const invocationId = await setupInvocation(worker);
    await assert.rejects(recordObservation(worker, {
      invocationId,
      correlationId: invocationId,
      // Missing `at` on exit → schema rejects.
      payload: { startup: {}, exit: { code: 0, signal: null, reason: null } as never, usage: null },
    }));
  } finally { await worker.close(); }
});

test("recordObservation raises NOT_FOUND for an unknown invocation", async () => {
  const worker = freshWorker();
  try {
    const fake = "00000000-0000-4000-8000-000000000000";
    await assert.rejects(recordObservation(worker, {
      invocationId: fake,
      correlationId: fake,
      payload: { startup: {}, exit: { at: new Date().toISOString(), code: 0, signal: null, reason: null }, usage: null },
    }), (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});
