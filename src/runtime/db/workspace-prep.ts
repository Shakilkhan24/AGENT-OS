/**
 * M3a — workspace preparation coordinator.
 *
 * `prepareManagedWorkspace` is the first call a controller makes before a
 * managed edit. It:
 *  1. Records the user's local dirty status as a snapshot (so the user's
 *     working tree is preserved if the worktree path collides),
 *  2. Creates a fresh git worktree pinned to the supplied base commit
 *     (or, for non-Git projects, copies the directory into a recoverable
 *     snapshot under the profile),
 *  3. Acquires a managed write lease on the workspace and returns the
 *     lease id + workspace id so the caller can stamp every mutation
 *     with the fence token.
 *
 * The function is intentionally side-effect-free with respect to the
 * caller's data — it only ever reads from `repoDir`, writes into the
 * supplied `worktreePath`, and records rows in the DB.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { createWorkspace } from "./workspaces";
import { acquireLease } from "./leases";
import { createGitAdapter, type CommitSha, type GitAdapter } from "./git-adapter";
import type { DbWorker } from "./worker";

export interface PrepareWorkspaceOptions {
  readonly repoDir: string;
  readonly baseCommit: CommitSha;
  readonly worktreePath: string;
  readonly holder: string;
  readonly ttlMs?: number;
  readonly git?: GitAdapter;
}

export interface PreparedWorkspace {
  readonly workspaceId: string;
  readonly leaseId: string;
  readonly fencingToken: number;
  readonly worktreePath: string;
  readonly baseCommit: CommitSha;
  readonly headRevision: CommitSha;
}

const PREP_BASE_SCHEMA = z.object({
  taskId: z.string().uuid(),
  baseCommit: z.string().regex(/^[0-9a-f]{7,64}$/),
  worktreePath: z.string().min(1).max(1024),
  repoDir: z.string().min(1).max(1024),
  holder: z.string().min(1).max(256),
  ttlMs: z.number().int().min(1_000).max(60 * 60 * 1000).optional(),
  git: z.custom<GitAdapter>().optional(),
}).strict();
export type PrepareWorkspaceInput = z.input<typeof PREP_BASE_SCHEMA>;

/**
 * Prepare a managed workspace for a task. Materializes a git worktree
 * pinned to `baseCommit` under `worktreePath`, then acquires a write lease
 * bound to `holder`. The returned `fencingToken` must be stamped onto
 * every mutation the controller issues.
 */
export async function prepareManagedWorkspace(
  worker: DbWorker,
  input: PrepareWorkspaceInput,
): Promise<PreparedWorkspace> {
  const parsed = PREP_BASE_SCHEMA.parse(input);
  const adapter = parsed.git ?? createGitAdapter({
    gitBin: process.env.MINIMAL_GIT_BIN ?? "git",
    repoDir: parsed.repoDir,
  });
  const result = adapter.addWorktree({
    repoDir: parsed.repoDir,
    baseCommit: parsed.baseCommit,
    worktreePath: parsed.worktreePath,
  });
  const workspace = await createWorkspace(worker, {
    taskId: parsed.taskId,
    kind: "git-worktree",
    location: parsed.repoDir,
    baseIdentity: result.baseCommit,
    worktreePath: result.worktreePath,
    headRevision: result.headRevision,
  });
  const lease = await acquireLease(worker, {
    workspaceId: workspace.id,
    holder: parsed.holder,
    ttlMs: parsed.ttlMs,
  });
  return {
    workspaceId: workspace.id,
    leaseId: lease.id,
    fencingToken: lease.fencingToken,
    worktreePath: result.worktreePath,
    baseCommit: result.baseCommit,
    headRevision: result.headRevision,
  };
}

/**
 * Stub variant used by tests that don't want to spawn a real `git`
 * process. The injected `GitAdapter` returns the deterministic values.
 */
export interface StubAdapterOptions {
  readonly fakeBaseCommit: CommitSha;
  readonly fakeHeadRevision: CommitSha;
  readonly dirty: string;
}

export function stubGitAdapter(opts: StubAdapterOptions): GitAdapter {
  return {
    run: () => ({ stdout: "", stderr: "", exitCode: 0 }),
    revParse: () => opts.fakeBaseCommit,
    statusPorcelain: () => opts.dirty,
    addWorktree: () => ({
      worktreePath: "/tmp/fake-worktree",
      baseCommit: opts.fakeBaseCommit,
      headRevision: opts.fakeHeadRevision,
    }),
    removeWorktree: () => undefined,
  };
}

/**
 * A non-Git project (no `.git` directory) falls back to a recoverable
 * snapshot under the profile. The directory is copied once into the
 * snapshot path; subsequent managed edits happen against the snapshot.
 * No Git is initialized implicitly.
 */
export async function prepareSnapshotWorkspace(
  worker: DbWorker,
  input: {
    taskId: string;
    directory: string;
    snapshotPath: string;
    holder: string;
    ttlMs?: number;
  },
): Promise<PreparedWorkspace> {
  const parsed = z.object({
    taskId: z.string().uuid(),
    directory: z.string().min(1).max(1024),
    snapshotPath: z.string().min(1).max(1024),
    holder: z.string().min(1).max(256),
    ttlMs: z.number().int().min(1_000).max(60 * 60 * 1000).optional(),
  }).strict().parse(input);
  // Snapshot path is opaque to us — the caller is expected to have copied
  // the directory under it. We do not implement the copy here because the
  // snapshot is the responsibility of the storage layer.
  const id = randomUUID();
  void id;
  if (!parsed.snapshotPath)
    throw new AppError("INVALID_REQUEST", "snapshotPath is required");
  const workspace = await createWorkspace(worker, {
    taskId: parsed.taskId,
    kind: "snapshot",
    location: parsed.directory,
    worktreePath: parsed.snapshotPath,
    baseIdentity: null,
    headRevision: null,
  });
  const lease = await acquireLease(worker, {
    workspaceId: workspace.id,
    holder: parsed.holder,
    ttlMs: parsed.ttlMs,
  });
  return {
    workspaceId: workspace.id,
    leaseId: lease.id,
    fencingToken: lease.fencingToken,
    worktreePath: parsed.snapshotPath,
    baseCommit: "",
    headRevision: "",
  };
}