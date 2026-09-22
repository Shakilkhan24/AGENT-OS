/**
 * M3c.4 — `renderCandidateDiff` service.
 *
 * Renders the unified diff for the candidate (base → tree) of a run.
 * The candidate identity triple `(baseIdentity, headRevision,
 * candidateDiff)` is bound to every `verification` and `review` row
 * (M3c.2); the diff body is fetched on demand from the workspace's
 * Git worktree so the renderer never has to shell out itself.
 *
 * Enforcement layers:
 *   (a) The `run` must exist (`NOT_FOUND` otherwise).
 *   (b) The task must have a workspace bound (`NOT_FOUND` if absent).
 *   (c) The workspace's `worktreePath` must be set
 *       (`UNSUPPORTED_RESTRICTION` — non-Git projects don't carry a
 *       candidate diff).
 *   (d) Both `baseIdentity` and `headRevision` must be set
 *       (`INVALID_REQUEST` — guards in-flight runs that haven't
 *       committed their first cursor yet).
 *   (e) The body is capped at `MAX_DIFF_BYTES` (256 KiB). A diff that
 *       overshoots the cap is returned with `truncated: true` and a
 *       body of exactly `MAX_DIFF_BYTES` characters; the renderer
 *       renders an "open the workspace" notice alongside.
 *   (f) `execFileSync` failures with non-empty stderr surface as
 *       `IO_ERROR` carrying the stderr tail. An empty diff is *not*
 *       an error — Git exits 0 with empty stdout for an unchanged
 *       worktree; the renderer renders "No changes".
 *
 * Test seam: `setCandidateDiffSpawn(factory)` swaps the underlying
 * `execFileSync` for the duration of a test so the runtime can be
 * exercised without a real Git binary. The override mirrors the
 * `setVerifierSpawn` pattern in `verifier-execute.ts`.
 */
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from "node:child_process";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { readRun } from "./runs";
import { listWorkspacesForTask } from "./workspaces";

/** M3c.4 — hard cap on diff body bytes returned to the renderer. */
export const MAX_DIFF_BYTES = 256 * 1024;

/** Slight headroom above `MAX_DIFF_BYTES` so the IPC schema can carry the truncated cap. */
export const MAX_DIFF_WIRE_BYTES = 512 * 1024;

export interface CandidateDiff {
  runId: string;
  base: string;
  tree: string;
  /** Bytes of the captured diff (uncapped). May exceed `MAX_DIFF_BYTES` when `truncated`. */
  bytes: number;
  /** True when the captured body was clamped to `MAX_DIFF_BYTES`. */
  truncated: boolean;
  /** The unified diff text (empty when `truncated` and no headroom). */
  body: string;
}

export type ExecFileSyncFn = (
  bin: string,
  args: ReadonlyArray<string>,
  opts: ExecFileSyncOptionsWithStringEncoding,
) => string | Buffer;

let spawnOverride: ExecFileSyncFn | undefined;

export function setCandidateDiffSpawn(factory: ExecFileSyncFn | undefined): void {
  spawnOverride = factory;
}
export function resetCandidateDiffSpawn(): void {
  spawnOverride = undefined;
}

const inputSchema = z.object({
  runId: z.string().uuid(),
}).strict();
export type RenderCandidateDiffInput = z.input<typeof inputSchema>;

const GIT_REV_REGEX = /^[0-9a-f]{7,64}$/;

export async function renderCandidateDiff(
  worker: DbWorker,
  input: RenderCandidateDiffInput,
): Promise<CandidateDiff> {
  const parsed = inputSchema.parse(input);
  const run = await readRun(worker, parsed.runId);
  if (!run) throw new AppError("NOT_FOUND", `Run not found: ${parsed.runId}`);

  // The candidate identity lives on the workspace, not on the run row
  // (the run only carries `baseRevision` for the dispatch-time pin).
  const workspaces = await listWorkspacesForTask(worker, run.taskId);
  // The most-recent workspace is the one bound to this run (matches the
  // `ORDER BY created_at DESC LIMIT 1` used by verifier-execute.ts).
  const workspace = workspaces[workspaces.length - 1];
  if (!workspace) throw new AppError("NOT_FOUND", "No workspace bound to this run's task");

  const worktreePath = workspace.worktreePath;
  if (!worktreePath)
    throw new AppError("UNSUPPORTED_RESTRICTION",
      "Workspace has no worktree path; candidate diff is not available for non-Git projects");

  const base = workspace.baseIdentity;
  const tree = workspace.headRevision;
  if (!base || !tree || !GIT_REV_REGEX.test(base) || !GIT_REV_REGEX.test(tree))
    throw new AppError("INVALID_REQUEST",
      `Workspace missing base or tree revisions (base=${base ?? "null"}, tree=${tree ?? "null"})`);

  const argv = [
    "-C", worktreePath,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    `${base}..${tree}`,
    "--",
  ] as const;

  const exec = spawnOverride ?? execFileSync;
  let raw: string | Buffer;
  try {
    raw = exec("git", [...argv], {
      encoding: "utf8",
      // Cap at 2× so we can detect an overshoot before truncating.
      maxBuffer: MAX_DIFF_BYTES * 2,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // execFileSync throws on non-zero exit. `error.status`, `error.stderr`
    // (Buffer | string), and `error.message` are populated when stdio
    // pipes the streams.
    const stderr = error && typeof error === "object" && "stderr" in error
      ? String((error as { stderr?: unknown }).stderr ?? "").trim()
      : "";
    const status = error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
    if (status === 0 && !stderr) {
      // An empty diff is not an error — treat as no changes.
      return { runId: parsed.runId, base, tree, bytes: 0, truncated: false, body: "" };
    }
    const tail = stderr.length > 1024 ? stderr.slice(0, 1024) + "…" : stderr;
    throw new AppError("IO_ERROR",
      `git diff failed (status=${String(status)}): ${tail || "no stderr"}`);
  }

  const body = typeof raw === "string" ? raw : raw.toString("utf8");
  if (body.length > MAX_DIFF_BYTES) {
    return {
      runId: parsed.runId, base, tree,
      bytes: body.length, truncated: true,
      body: body.slice(0, MAX_DIFF_BYTES),
    };
  }
  return {
    runId: parsed.runId, base, tree,
    bytes: body.length, truncated: false, body,
  };
}
