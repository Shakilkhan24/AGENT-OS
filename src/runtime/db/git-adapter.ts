/**
 * M3a — Git worktree adapter.
 *
 * A managed workspace defaults to a fresh `git worktree add` against a
 * pinned committed base. The user's dirty checkout is preserved by
 * spawning the worktree from the commit hash they chose; their
 * uncommitted work is never touched.
 *
 * The adapter spawns the git CLI as a child process (no embedded libgit2
 * surface to maintain, predictable exit codes, and version pinned by the
 * binary on PATH). A `GitAdapter` is constructed with the path to the
 * `git` binary plus a working directory; methods run synchronously and
 * return structured results. Errors carry the git exit code so callers
 * can branch on them.
 */
import { spawnSync } from "node:child_process";

/** A pinned commit (7 to 64 lowercase hex characters). */
export type CommitSha = string;

export interface WorktreeSpec {
  /** Path to the working directory (the repo root). */
  readonly repoDir: string;
  /** Commit to base the new worktree on. */
  readonly baseCommit: CommitSha;
  /** Filesystem path for the new worktree. */
  readonly worktreePath: string;
  /** Optional branch name (a detached HEAD is created if omitted). */
  readonly branch?: string;
}

export interface WorktreeResult {
  readonly worktreePath: string;
  readonly baseCommit: CommitSha;
  readonly headRevision: CommitSha;
}

/** Outcome of a single git invocation. */
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export class GitError extends Error {
  constructor(public readonly result: GitResult, message: string) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitAdapter {
  /** Run an arbitrary git subcommand and capture output. */
  run(args: readonly string[]): GitResult;
  /** Resolve HEAD to a full 40-character SHA. */
  revParse(ref: string): CommitSha;
  /** Return the dirty-tree status (porcelain v1). Empty string = clean. */
  statusPorcelain(): string;
  /** Create a worktree at `worktreePath` based on `baseCommit`. */
  addWorktree(spec: WorktreeSpec): WorktreeResult;
  /** Remove a worktree that this adapter created. */
  removeWorktree(worktreePath: string, force?: boolean): void;
}

interface AdapterOptions {
  readonly gitBin: string;
  readonly repoDir: string;
  readonly env?: Readonly<Record<string, string>>;
}

export function createGitAdapter(options: AdapterOptions): GitAdapter {
  const { gitBin, repoDir } = options;
  const env = { ...process.env, ...(options.env ?? {}) };

  function run(args: readonly string[]): GitResult {
    const result = spawnSync(gitBin, args, {
      cwd: repoDir,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? -1,
    };
  }

  function revParse(ref: string): CommitSha {
    const result = run(["rev-parse", "--verify", ref]);
    if (result.exitCode !== 0)
      throw new GitError(result, `git rev-parse ${ref} failed`);
    return result.stdout.trim();
  }

  function statusPorcelain(): string {
    const result = run(["status", "--porcelain"]);
    if (result.exitCode !== 0)
      throw new GitError(result, "git status --porcelain failed");
    return result.stdout;
  }

  function addWorktree(spec: WorktreeSpec): WorktreeResult {
    const baseSha = revParse(`${spec.baseCommit}^{commit}`);
    const args = ["worktree", "add"];
    if (spec.branch) args.push("-b", spec.branch);
    else args.push("--detach");
    args.push(spec.worktreePath, baseSha);
    const result = run(args);
    if (result.exitCode !== 0)
      throw new GitError(result, `git worktree add ${spec.worktreePath} ${baseSha} failed`);
    const headRevision = revParse("HEAD");
    return { worktreePath: spec.worktreePath, baseCommit: baseSha, headRevision };
  }

  function removeWorktree(worktreePath: string, force = false): void {
    const args = ["worktree", "remove"];
    if (force) args.push("--force");
    args.push(worktreePath);
    const result = run(args);
    if (result.exitCode !== 0)
      throw new GitError(result, `git worktree remove ${worktreePath} failed`);
  }

  return { run, revParse, statusPorcelain, addWorktree, removeWorktree };
}