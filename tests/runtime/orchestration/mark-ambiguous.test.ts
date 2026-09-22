/**
 * M3b.2 — `markAmbiguous` tests.
 *
 * Coverage:
 *  - `markAmbiguous` transitions an in-flight invocation to `error` with
 *    the canonical `ambiguous-dispatch` reason.
 *  - A `dispatch.ambiguous` audit event is written with the supplied
 *    detail string.
 *  - Calling `markAmbiguous` twice on the same invocation is idempotent
 *    (the second call surfaces the existing terminal state).
 *  - Refusing a `reason` outside the 1..256-character range raises
 *    INVALID_REQUEST.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun } from "../../../src/runtime/db/runs";
import { createInvocation, transitionInvocation, readInvocation } from "../../../src/runtime/db/invocations";
import { markAmbiguous } from "../../../src/runtime/orchestration/uncertain";
import { AppError } from "../../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function spawnInvocation(worker: DbWorker) {
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

test("markAmbiguous transitions the invocation to error and stamps ambiguous-dispatch", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnInvocation(worker);
    const result = await markAmbiguous(worker, {
      invocationId: id, correlationId: id, reason: "no first ack in 5s",
    });
    assert.equal(result.outcome, "error");
    assert.equal(result.endedReason, "ambiguous-dispatch");
    const after = await readInvocation(worker, id);
    assert.equal(after?.status, "error");
    assert.equal(after?.endedReason, "ambiguous-dispatch");
  } finally { await worker.close(); }
});

test("markAmbiguous writes a dispatch.ambiguous audit event carrying the detail", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnInvocation(worker);
    const result = await markAmbiguous(worker, {
      invocationId: id, correlationId: id, reason: "broken pipe",
    });
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare("SELECT * FROM event WHERE seq = ?").first(result.eventSeq);
    assert.equal(row?.type, "dispatch.ambiguous");
    const payload = JSON.parse(String(row?.payload_json));
    assert.equal(payload.invocationId, id);
    assert.equal(payload.reason, "broken pipe");
  } finally { await worker.close(); }
});

test("markAmbiguous is idempotent on a terminal invocation", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnInvocation(worker);
    await markAmbiguous(worker, { invocationId: id, correlationId: id, reason: "first" });
    const second = await markAmbiguous(worker, { invocationId: id, correlationId: id, reason: "second" });
    // The second call sees the terminal state and returns without a new
    // event. eventSeq === -1 is the sentinel used by markAmbiguous.
    assert.equal(second.eventSeq, -1);
  } finally { await worker.close(); }
});

test("markAmbiguous refuses empty or too-long reasons", async () => {
  const worker = freshWorker();
  try {
    const id = await spawnInvocation(worker);
    await assert.rejects(markAmbiguous(worker, {
      invocationId: id, correlationId: id, reason: "",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
    await assert.rejects(markAmbiguous(worker, {
      invocationId: id, correlationId: id, reason: "x".repeat(257),
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});

test("markAmbiguous raises NOT_FOUND for unknown invocation", async () => {
  const worker = freshWorker();
  try {
    const fake = "00000000-0000-4000-8000-000000000000";
    await assert.rejects(markAmbiguous(worker, {
      invocationId: fake, correlationId: fake, reason: "x",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});