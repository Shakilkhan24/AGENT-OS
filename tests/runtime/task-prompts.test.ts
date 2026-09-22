/**
 * M3c.5 — task-prompt draft persistence tests.
 *
 * The drafts live in the `meta` table (not the `draft` table, which
 * is file-bound) following the same pattern as the M2.6
 * `draft:restored:<id>` marker. The optimistic-update revision
 * mirrors `saveDraft`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  readTaskPromptDraft,
  removeTaskPromptDraft,
  saveTaskPromptDraft,
  TASK_PROMPT_META_PREFIX,
} from "../../src/runtime/db/task-prompts";
import { createTask } from "../../src/runtime/db/tasks";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const ZERO_HASH = "0".repeat(64);

test("saveTaskPromptDraft creates a draft at revision 1 and readTaskPromptDraft returns it", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, {
      title: "draft-1", hostId: "h", projectId: "p",
    });
    const draftBefore = await readTaskPromptDraft(worker, taskId);
    assert.equal(draftBefore, undefined);

    const saved = await saveTaskPromptDraft(worker, taskId, {
      content: "explain the auth flow",
      baseHash: ZERO_HASH,
      expectedRevision: null,
    });
    assert.equal(saved.revision, 1);
    assert.equal(saved.content, "explain the auth flow");
    assert.equal(saved.baseHash, ZERO_HASH);
    assert.match(saved.updatedAt, /^\d{4}-\d{2}-\d{2}T/);

    const draftAfter = await readTaskPromptDraft(worker, taskId);
    assert.ok(draftAfter);
    assert.equal(draftAfter!.revision, 1);
    assert.equal(draftAfter!.content, "explain the auth flow");
    assert.equal(draftAfter!.baseHash, ZERO_HASH);
  } finally { await worker.close(); }
});

test("saveTaskPromptDraft with stale expectedRevision throws CONFLICT and a matching expectedRevision bumps revision", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, {
      title: "draft-2", hostId: "h", projectId: "p",
    });
    const first = await saveTaskPromptDraft(worker, taskId, {
      content: "v1", baseHash: ZERO_HASH, expectedRevision: null,
    });
    assert.equal(first.revision, 1);

    // Stale: expected 0, found 1 → CONFLICT.
    let conflictError: unknown;
    try {
      await saveTaskPromptDraft(worker, taskId, {
        content: "v2-stale", baseHash: ZERO_HASH, expectedRevision: 0,
      });
      assert.fail("Expected saveTaskPromptDraft with stale revision to throw CONFLICT");
    } catch (error) {
      conflictError = error;
    }
    assert.ok(conflictError instanceof AppError);
    assert.equal((conflictError as AppError).failure.code, "CONFLICT");
    assert.match((conflictError as AppError).message, /expected r0, found r1/);

    // Matching: expected 1 → revision 2.
    const second = await saveTaskPromptDraft(worker, taskId, {
      content: "v2", baseHash: ZERO_HASH, expectedRevision: 1,
    });
    assert.equal(second.revision, 2);
    assert.equal(second.content, "v2");

    const read = await readTaskPromptDraft(worker, taskId);
    assert.ok(read);
    assert.equal(read!.revision, 2);
    assert.equal(read!.content, "v2");
  } finally { await worker.close(); }
});

test("removeTaskPromptDraft removes the row and readTaskPromptDraft returns undefined afterwards", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, {
      title: "draft-3", hostId: "h", projectId: "p",
    });
    await saveTaskPromptDraft(worker, taskId, {
      content: "to be discarded", baseHash: ZERO_HASH, expectedRevision: null,
    });
    const before = await readTaskPromptDraft(worker, taskId);
    assert.ok(before);

    await removeTaskPromptDraft(worker, taskId);
    const after = await readTaskPromptDraft(worker, taskId);
    assert.equal(after, undefined);

    // Idempotent: removing a missing draft is a no-op.
    await removeTaskPromptDraft(worker, taskId);

    // Internal sanity: the meta row was actually deleted.
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { first: (...args: unknown[]) => unknown } } }).driver;
    const row = driver.prepare("SELECT key FROM meta WHERE key = ?").first(`${TASK_PROMPT_META_PREFIX}${taskId}`);
    assert.equal(row, undefined);
  } finally { await worker.close(); }
});

test("saveTaskPromptDraft rejects content over the 64 KiB cap with Zod validation", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, {
      title: "draft-4", hostId: "h", projectId: "p",
    });
    const huge = "x".repeat(64 * 1024 + 1);
    let oversized: unknown;
    try {
      await saveTaskPromptDraft(worker, taskId, {
        content: huge, baseHash: ZERO_HASH, expectedRevision: null,
      });
      assert.fail("Expected oversized content to throw Zod validation");
    } catch (error) {
      oversized = error;
    }
    const message = oversized instanceof Error ? oversized.message : String(oversized);
    assert.match(message, /at most 65536 characters|too_big|content/i);
  } finally { await worker.close(); }
});
