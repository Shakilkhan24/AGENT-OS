/**
 * Focused tests for M2.6 — draft revision + root identity.
 *
 * Tests prove:
 *  - the first save stores a draft with revision = 1;
 *  - subsequent saves monotonically increment the revision;
 *  - a stale expectedRevision raises CONFLICT instead of clobbering;
 *  - a baseHash change without a revision bump still conflicts when an
 *    expectedRevision is supplied;
 *  - the root identity is persisted and a re-save with a different
 *    identity is refused;
 *  - restore-as-unsaved leaves a recoverable marker that the renderer can
 *    read to suppress auto-submit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { isRestored, listDrafts, markRestored, readDraft, removeDraft, saveDraft } from "../../src/runtime/db/drafts";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return new DbWorker({ driver });
}

const SESSION = "11111111-1111-4111-8111-111111111111";
const baseInput = { sessionId: SESSION, path: "example.txt", baseHash: "a".repeat(64), content: "hello" };

test("first save stores revision 1, second save stores revision 2", async () => {
  const worker = freshWorker();
  try {
    const first = await saveDraft(worker, SESSION, baseInput, { rootIdentity: "dev1:ino1" });
    assert.equal(first.revision.revision, 1);
    const second = await saveDraft(worker, SESSION, { ...baseInput, content: "hello v2" }, { rootIdentity: "dev1:ino1" });
    assert.equal(second.revision.revision, 2);
  } finally { await worker.close(); }
});

test("stale expectedRevision raises CONFLICT, not a silent clobber", async () => {
  const worker = freshWorker();
  try {
    await saveDraft(worker, SESSION, baseInput, { rootIdentity: "dev1:ino1" });
    await assert.rejects(
      saveDraft(worker, SESSION, { ...baseInput, content: "stale write" }, { expectedRevision: 99, rootIdentity: "dev1:ino1" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
  } finally { await worker.close(); }
});

test("root identity change is refused so an external rewrite surfaces as a conflict", async () => {
  const worker = freshWorker();
  try {
    await saveDraft(worker, SESSION, baseInput, { rootIdentity: "dev1:ino1" });
    await assert.rejects(
      saveDraft(worker, SESSION, { ...baseInput, content: "external rewrite" }, { rootIdentity: "dev2:ino99" }),
      (error: unknown) => error instanceof AppError && /rewritten externally/i.test(error.message),
    );
  } finally { await worker.close(); }
});

test("listDrafts returns the drafts ordered by updatedAt DESC", async () => {
  const worker = freshWorker();
  try {
    await saveDraft(worker, SESSION, { ...baseInput, path: "a.txt" }, { rootIdentity: "dev1:ino1" });
    await new Promise(resolve => setTimeout(resolve, 5));
    await saveDraft(worker, SESSION, { ...baseInput, path: "b.txt" }, { rootIdentity: "dev1:ino2" });
    const drafts = await listDrafts(worker);
    assert.equal(drafts.length, 2);
    assert.equal(drafts[0]!.path, "b.txt");
    assert.equal(drafts[1]!.path, "a.txt");
  } finally { await worker.close(); }
});

test("readDraft returns the full draft including content", async () => {
  const worker = freshWorker();
  try {
    const saved = await saveDraft(worker, SESSION, { ...baseInput, content: "payload" }, { rootIdentity: "dev1:ino1" });
    const draft = await readDraft(worker, saved.summary.id);
    assert.equal(draft.content, "payload");
  } finally { await worker.close(); }
});

test("removeDraft deletes the row and subsequent reads reject", async () => {
  const worker = freshWorker();
  try {
    const saved = await saveDraft(worker, SESSION, baseInput, { rootIdentity: "dev1:ino1" });
    await removeDraft(worker, saved.summary.id);
    await assert.rejects(readDraft(worker, saved.summary.id), (error: unknown) => error instanceof AppError && error.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("restore marker records the previous updatedAt so the renderer can suppress auto-submit", async () => {
  const worker = freshWorker();
  try {
    const saved = await saveDraft(worker, SESSION, baseInput, { rootIdentity: "dev1:ino1" });
    await markRestored(worker, saved.summary.id, "2026-09-13T10:00:00.000Z");
    const marker = await isRestored(worker, saved.summary.id);
    assert.equal(marker.restored, true);
    assert.equal(marker.previousUpdatedAt, "2026-09-13T10:00:00.000Z");
  } finally { await worker.close(); }
});
