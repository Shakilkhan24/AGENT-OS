/**
 * M4.6.b — revision-update tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  recordRevisionUpdate,
  listRevisionUpdates,
  readCurrentRevision,
  REVISION_UPDATE_META_PREFIX,
  recordKey,
} from "../../src/runtime/db/revision-update";
import { createTask, readTask } from "../../src/runtime/db/tasks";
import { createRun, readRun } from "../../src/runtime/db/runs";
import { randomUUID } from "node:crypto";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

test("first recordRevisionUpdate writes seq=1 and updates run.base_revision to headRevision", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: "abcdef0" });
    const rec = await recordRevisionUpdate(worker, {
      runId,
      baseRevision: "abcdef0",
      headRevision: "1234567",
      sourceDigest: "a".repeat(64),
      rationale: "initial pinning",
      actor: "user-1",
    });
    assert.equal(rec.seq, 1);
    assert.equal(rec.headRevision, "1234567");
    const run = await readRun(worker, runId);
    assert.equal(run?.baseRevision, "1234567");
    assert.equal(readCurrentRevision(worker, runId), "1234567");
  } finally { await worker.close(); }
});

test("second recordRevisionUpdate for the same run yields seq=2; rebind to same sourceDigest allowed", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: "abcdef0" });
    const sourceDigest = "b".repeat(64);
    await recordRevisionUpdate(worker, {
      runId, baseRevision: "abcdef0", headRevision: "1111111",
      sourceDigest, rationale: "first", actor: "user-1",
    });
    // Same (baseRevision, sourceDigest) but new headRevision — allowed
    // (the normal "rebase onto a newer head from the same source identity" flow).
    const rec2 = await recordRevisionUpdate(worker, {
      runId, baseRevision: "abcdef0", headRevision: "2222222",
      sourceDigest, rationale: "rebase", actor: "user-1",
    });
    assert.equal(rec2.seq, 2);
    assert.equal(rec2.headRevision, "2222222");
    const all = listRevisionUpdates(worker, runId);
    assert.equal(all.length, 2);
    assert.equal(all[0].seq, 1);
    assert.equal(all[1].seq, 2);
  } finally { await worker.close(); }
});

test("recordRevisionUpdate refuses rebinding (runId, baseRevision) to a different sourceDigest (CONFLICT)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: "abcdef0" });
    await recordRevisionUpdate(worker, {
      runId, baseRevision: "abcdef0", headRevision: "1111111",
      sourceDigest: "c".repeat(64), rationale: "first", actor: "user-1",
    });
    await assert.rejects(recordRevisionUpdate(worker, {
      runId, baseRevision: "abcdef0", headRevision: "3333333",
      sourceDigest: "d".repeat(64), rationale: "tamper", actor: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("listRevisionUpdates returns rows in ascending seq order", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: "abcdef0" });
    for (const head of ["1111111", "2222222", "3333333"]) {
      await recordRevisionUpdate(worker, {
        runId, baseRevision: "abcdef0", headRevision: head,
        sourceDigest: "e".repeat(64), rationale: "x", actor: "user-1",
      });
    }
    const all = listRevisionUpdates(worker, runId);
    assert.deepEqual(all.map((r) => r.seq), [1, 2, 3]);
    assert.deepEqual(all.map((r) => r.headRevision), ["1111111", "2222222", "3333333"]);
  } finally { await worker.close(); }
});

test("recordRevisionUpdate for an unknown runId raises NOT_FOUND", async () => {
  const worker = freshWorker();
  try {
    // Ensure at least one task exists so the `readTask(worker, randomUUID())` path
    // doesn't matter for the negative test.
    void await readTask(worker, randomUUID());
    await assert.rejects(recordRevisionUpdate(worker, {
      runId: randomUUID(), baseRevision: "abcdef0", headRevision: "1111111",
      sourceDigest: "f".repeat(64), rationale: "x", actor: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("recordRevisionUpdate refuses empty fields (INVALID_REQUEST)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    await assert.rejects(recordRevisionUpdate(worker, {
      runId, baseRevision: "", headRevision: "1111111",
      sourceDigest: "1".repeat(64), rationale: "x", actor: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});

test("meta-key builder is correct", () => {
  const runId = randomUUID();
  assert.equal(recordKey(runId, 1), `${REVISION_UPDATE_META_PREFIX}${runId}:1`);
  assert.equal(recordKey(runId, 17), `${REVISION_UPDATE_META_PREFIX}${runId}:17`);
});

test("readCurrentRevision returns undefined for an unknown runId", async () => {
  const worker = freshWorker();
  try {
    assert.equal(readCurrentRevision(worker, randomUUID()), undefined);
  } finally { await worker.close(); }
});
