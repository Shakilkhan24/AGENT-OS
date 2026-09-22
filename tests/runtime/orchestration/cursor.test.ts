/**
 * M3b.3 — cursor commit tests.
 *
 * Coverage:
 *  - `commitCursor` writes the observation event, transitions the
 *    invocation to its terminal state, and writes a `cursor.committed`
 *    audit event in the same transaction.
 *  - The invocation's `ended_reason` is stamped with the supplied
 *    `reason`.
 *  - Calling `commitCursor` twice on the same invocation raises
 *    CONFLICT (the second commit can't demote a terminal invocation).
 *  - Empty / over-long reasons raise INVALID_REQUEST.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun } from "../../../src/runtime/db/runs";
import { createInvocation, readInvocation, transitionInvocation } from "../../../src/runtime/db/invocations";
import { commitCursor } from "../../../src/runtime/orchestration/cursor";
import { AppError } from "../../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function spawnSpawned(worker: DbWorker): Promise<string> {
  const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  const invocation = await createInvocation(worker, {
    runId: run.id, idempotencyKey: "k", canonicalDigest: "a".repeat(64),
    providerVersion: "v", model: "m", accountMode: "authenticated",
  });
  await transitionInvocation(worker, invocation.id, { to: "admitted" });
  await transitionInvocation(worker, invocation.id, { to: "spawned" });
  return invocation.id;
}

const exitPayload = (code: number, signal: string | null) => ({
  startup: { kind: "test" },
  exit: { at: new Date().toISOString(), code, signal, reason: null },
  usage: null,
});

test("commitCursor writes observation + cursor.committed and lands the invocation in done", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnSpawned(worker);
    const result = await commitCursor(worker, {
      invocationId: id, correlationId: id,
      payload: exitPayload(0, null),
      outcome: "done",
      reason: "verified",
    });
    assert.equal(result.outcome, "done");
    const driver = (worker as unknown as { driver: { prepare(sql: string): { all(...b: unknown[]): Array<Record<string, unknown>> } } }).driver;
    const all = driver.prepare("SELECT type FROM event ORDER BY seq ASC").all();
    const types = all.map(r => String(r.type));
    assert.ok(types.includes("provider.observation"));
    assert.ok(types.includes("cursor.committed"));
    const after = await readInvocation(worker, id);
    assert.equal(after?.status, "done");
    assert.equal(after?.endedReason, "verified");
  } finally { await worker.close(); }
});

test("commitCursor refuses to commit twice on the same invocation", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnSpawned(worker);
    await commitCursor(worker, {
      invocationId: id, correlationId: id,
      payload: exitPayload(0, null),
      outcome: "done", reason: "first",
    });
    await assert.rejects(commitCursor(worker, {
      invocationId: id, correlationId: id,
      payload: exitPayload(0, null),
      outcome: "done", reason: "second",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("commitCursor rejects empty and over-long reasons", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnSpawned(worker);
    await assert.rejects(commitCursor(worker, {
      invocationId: id, correlationId: id,
      payload: exitPayload(0, null),
      outcome: "done", reason: "",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
    await assert.rejects(commitCursor(worker, {
      invocationId: id, correlationId: id,
      payload: exitPayload(0, null),
      outcome: "done", reason: "x".repeat(257),
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});
