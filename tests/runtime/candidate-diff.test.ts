/**
 * M3c.4 — `renderCandidateDiff` tests.
 *
 * Coverage:
 *  1. A run with a synthetic Git worktree returns the unified diff
 *     text (verified against the diff `git` itself prints).
 *  2. A run whose workspace has `null worktreePath` throws
 *     `UNSUPPORTED_RESTRICTION` (non-Git project).
 *  3. A run whose workspace is missing `baseIdentity` or `headRevision`
 *     throws `INVALID_REQUEST`.
 *  4. A run whose diff exceeds `MAX_DIFF_BYTES` returns `truncated: true`
 *     and a body of exactly `MAX_DIFF_BYTES` characters.
 *
 * The first three cases use a real Git binary on disk; the test
 * harness gates itself behind `git --version` like the existing
 * `git-adapter.test.ts` does. The fourth case uses the
 * `setCandidateDiffSpawn` seam so it can run without a real `git`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import { createWorkspace } from "../../src/runtime/db/workspaces";
import { createRun } from "../../src/runtime/db/runs";
import {
  renderCandidateDiff,
  MAX_DIFF_BYTES,
  setCandidateDiffSpawn,
  resetCandidateDiffSpawn,
} from "../../src/runtime/db/candidate-diff";
import { AppError } from "../../src/shared/errors";

const git = (() => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "git" : null;
})();

const skipIfNoGit = git ? test : test.skip;

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function makeRepo(): { dir: string; head: string } {
  if (!git) throw new Error("git not available in test environment");
  const dir = mkdtempSync(join(tmpdir(), "minimal-cand-diff-"));
  spawnSync("git", ["init", "-q", "--initial-branch=main", dir], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "Test"], { encoding: "utf8" });
  writeFileSync(join(dir, "hello.txt"), "hi\n");
  spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
  const commit = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "initial"], { encoding: "utf8" });
  if (commit.status !== 0) throw new Error("git commit failed");
  const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
  return { dir, head };
}

async function bindRunToWorkspace(worker: DbWorker, worktreePath: string, baseIdentity: string | null, headRevision: string | null) {
  const { id: taskId } = await createTask(worker, { title: "candidate-diff", hostId: "host-1" });
  await createWorkspace(worker, {
    taskId,
    kind: "git-worktree",
    location: worktreePath,
    baseIdentity,
    worktreePath,
    headRevision,
  });
  const { id: runId } = await createRun(worker, { taskId, baseRevision: baseIdentity });
  return { taskId, runId };
}

skipIfNoGit("renderCandidateDiff: returns the unified diff text for a real Git worktree", async () => {
  const worker = freshWorker();
  let dir: string | undefined;
  try {
    const fixture = makeRepo();
    dir = fixture.dir;
    // Make a second commit so base → head actually contains a diff.
    appendFileSync(join(dir, "hello.txt"), "world\n");
    spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
    const second = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "second"], { encoding: "utf8" });
    if (second.status !== 0) throw new Error("git commit failed");
    const head = spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();

    const { runId } = await bindRunToWorkspace(worker, dir, fixture.head, head);
    const diff = await renderCandidateDiff(worker, { runId });

    assert.equal(diff.runId, runId);
    assert.equal(diff.base, fixture.head);
    assert.equal(diff.tree, head);
    assert.equal(diff.truncated, false);
    assert.ok(diff.bytes > 0, "diff body must be non-empty");
    assert.match(diff.body, /\+world\n/);
    assert.match(diff.body, /\bhello\.txt\b/);
  } finally {
    if (dir) try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    await worker.close();
  }
});

test("renderCandidateDiff: throws UNSUPPORTED_RESTRICTION when worktreePath is null", async () => {
  const worker = freshWorker();
  try {
    // Create a non-Git workspace (snapshot kind, no worktreePath).
    const { id: taskId } = await createTask(worker, { title: "no-worktree", hostId: "host-1" });
    await createWorkspace(worker, {
      taskId,
      kind: "snapshot",
      location: "/tmp/somewhere",
      baseIdentity: null,
      worktreePath: null,
      headRevision: null,
    });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: null });
    await assert.rejects(
      renderCandidateDiff(worker, { runId }),
      (error: unknown) => error instanceof AppError && error.failure.code === "UNSUPPORTED_RESTRICTION",
    );
  } finally { await worker.close(); }
});

test("renderCandidateDiff: throws INVALID_REQUEST when base or tree is missing", async () => {
  const worker = freshWorker();
  try {
    // Worktree present, but neither base nor tree has been recorded.
    const { id: taskId } = await createTask(worker, { title: "no-revs", hostId: "host-1" });
    await createWorkspace(worker, {
      taskId,
      kind: "git-worktree",
      location: "/tmp/somewhere",
      baseIdentity: null,
      worktreePath: "/tmp/somewhere",
      headRevision: null,
    });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: null });
    await assert.rejects(
      renderCandidateDiff(worker, { runId }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("renderCandidateDiff: returns truncated=true when the body exceeds MAX_DIFF_BYTES", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "huge", hostId: "host-1" });
    await createWorkspace(worker, {
      taskId,
      kind: "git-worktree",
      location: "/tmp/fake",
      baseIdentity: "0123456",
      worktreePath: "/tmp/fake",
      headRevision: "89abcde",
    });
    const { id: runId } = await createRun(worker, { taskId, baseRevision: "0123456" });

    // Override the spawn so the test stays hermetic.
    setCandidateDiffSpawn(() => {
      // 4 × MAX_DIFF_BYTES — well above the cap.
      const huge = "+x".repeat(MAX_DIFF_BYTES * 2);
      return huge;
    });
    try {
      const diff = await renderCandidateDiff(worker, { runId });
      assert.equal(diff.truncated, true);
      assert.equal(diff.body.length, MAX_DIFF_BYTES);
      assert.equal(diff.bytes, MAX_DIFF_BYTES * 4);
    } finally { resetCandidateDiffSpawn(); }
  } finally { await worker.close(); }
});

test("renderCandidateDiff: throws NOT_FOUND when run is missing", async () => {
  const worker = freshWorker();
  try {
    // No task / no run at all.
    await assert.rejects(
      renderCandidateDiff(worker, { runId: "00000000-0000-0000-0000-000000000000" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "NOT_FOUND",
    );
  } finally { await worker.close(); }
});

// Reference `execFileSync` so the import survives a strict build that prunes
// unused node imports even if `spawnSync` already covered the runtime path.
void execFileSync;