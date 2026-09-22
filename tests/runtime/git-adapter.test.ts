/**
 * M3a Increment 2 — Git adapter tests.
 *
 * Coverage:
 *  - `run` invokes the configured git binary and returns structured output.
 *  - `revParse` returns the trimmed SHA and reports a GitError on failure.
 *  - `statusPorcelain` returns the raw status text (empty == clean).
 *  - `addWorktree` builds the correct argument list and parses the
 *    head revision; surfaces a GitError on non-zero exit.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitAdapter, GitError } from "../../src/runtime/db/git-adapter";

const git = (() => {
  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  return probe.status === 0 ? "git" : null;
})();

function makeRepo(): string {
  if (!git) throw new Error("git not available in test environment");
  const dir = mkdtempSync(join(tmpdir(), "minimal-git-"));
  const init = spawnSync("git", ["init", "-q", "--initial-branch=main", dir], { encoding: "utf8" });
  if (init.status !== 0) throw new Error("git init failed");
  spawnSync("git", ["-C", dir, "config", "user.email", "test@example.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "Test"], { encoding: "utf8" });
  writeFileSync(join(dir, "hello.txt"), "hi\n");
  spawnSync("git", ["-C", dir, "add", "."], { encoding: "utf8" });
  const commit = spawnSync("git", ["-C", dir, "commit", "-q", "-m", "initial"], { encoding: "utf8" });
  if (commit.status !== 0) throw new Error("git commit failed");
  return dir;
}

const skipIfNoGit = git ? test : test.skip;

skipIfNoGit("run forwards args + cwd + captures output", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    const result = adapter.run(["status", "--porcelain"]);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout.trim(), "");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

skipIfNoGit("revParse returns the trimmed SHA", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    const sha = adapter.revParse("HEAD");
    assert.match(sha, /^[0-9a-f]{40}$/);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

skipIfNoGit("revParse throws GitError on a missing ref", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    assert.throws(() => adapter.revParse("definitely-not-a-ref"), (err: unknown) => err instanceof GitError);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

skipIfNoGit("statusPorcelain returns clean text on a clean tree", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    assert.equal(adapter.statusPorcelain(), "");
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

skipIfNoGit("addWorktree creates a worktree pinned to the base commit", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    const base = adapter.revParse("HEAD");
    const wtDir = join(repo, "wt");
    const result = adapter.addWorktree({ repoDir: repo, baseCommit: base, worktreePath: wtDir });
    assert.equal(result.baseCommit, base);
    assert.equal(result.headRevision, base);
    assert.equal(result.worktreePath, wtDir);
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", join(repo, "wt")], { encoding: "utf8" });
    rmSync(repo, { recursive: true, force: true });
  }
});

skipIfNoGit("addWorktree throws GitError when the base is bogus", () => {
  const repo = makeRepo();
  try {
    const adapter = createGitAdapter({ gitBin: git!, repoDir: repo });
    assert.throws(() => adapter.addWorktree({
      repoDir: repo, baseCommit: "deadbeef", worktreePath: join(repo, "wt"),
    }), (err: unknown) => err instanceof GitError);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});