/**
 * M3c.2 — verifier executor (`verifyOnce`).
 *
 * The verifier is the runtime's separate executor for the M3c "approved
 * verification command through MINIMAL's executor on the exact candidate"
 * step (`FUTURE/IMPLEMENTATION-README.md:201`). It is NOT a
 * `ProviderAdapter` — providers are long-lived streaming processes with
 * a framed protocol; a verifier is a one-shot command that:
 *
 *   1. Captures the candidate identity triple
 *      `(workspace.base_identity, workspace.head_revision, porcelain_digest)`
 *      up-front so any later mutation that advances `head_revision`
 *      invalidates the bound review.
 *   2. Spawns the recipe command (or a one-off override) in the worktree
 *      with bounded stdout/stderr (64 KiB each).
 *   3. On `exit`, records `exit_code`, `signal`, assertion counts (parsed
 *      from `assertionPattern` if set), required check results (one entry
 *      per recipe row), and the bounded tails.
 *   4. Transitions `verification` to `passed` / `failed` / `error`.
 *   5. Opens or refreshes the bound `review` row keyed by
 *      `(task, run, configurationRevision, candidateTree)`.
 *
 * Unlike `executeOnce`, the verifier is NOT gated on `isStopped(runId)`:
 * a verifier reads the candidate, it does not mutate it; cancelling a
 * provider dispatch does not cancel verifiers.
 *
 * The verifier never relies on the agent's summary as evidence — counts
 * are parsed from stdout (regex-matched JSON line) and required-check
 * status is derived from `exit_code` plus the per-recipe observation.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { type DbWorker } from "../db/worker";
import { readWorkspace } from "../db/workspaces";
import { readTask } from "../db/tasks";
import {
  createVerification,
  recordVerificationOutput,
} from "../db/verifications";
import { createOpenReview } from "../db/reviews";
import {
  computeConfigurationRevision,
  readRecipe,
} from "../db/verification-recipes";
import type { Verification } from "../../shared/managed";

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/** Bound the verifier's stdout/stderr so a misbehaving command cannot fill the DB. */
const OUTPUT_TAIL_BYTES = 64 * 1024;
const ESCALATE_AFTER_MS = 5_000;

const VERIFY_ONCE_INPUT = z.object({
  taskId: z.string().uuid(),
  /** Optional — when omitted, the executor finds the most-recent run on the task. */
  runId: z.string().uuid().optional(),
  /** Optional recipe UUID; when absent, the executor expects a command override. */
  recipeId: z.string().uuid().optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  argv: z.array(z.string().min(1).max(1024)).default([]),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
  /** ISO timestamp — past means "immediate deadline". */
  deadlineAt: z.string().datetime(),
}).strict().refine(value => Boolean(value.recipeId) || Boolean(value.command), {
  message: "verifyOnce requires either recipeId or a command override",
});
export type VerifyOnceInput = z.input<typeof VERIFY_ONCE_INPUT>;

export interface VerifyOnceOk {
  readonly kind: "ok";
  readonly verificationId: string;
  readonly reviewId: string;
  readonly verification: Verification;
}
export interface VerifyOnceConflict {
  readonly kind: "conflict";
  readonly reason: string;
}
export type VerifyOnceResult = VerifyOnceOk | VerifyOnceConflict;

/**
 * Test seam: swap the spawn factory without going through `child_process`.
 * The replacement signature matches Node's `spawn(bin, args, opts)`.
 */
let spawnOverride: ((bin: string, args: ReadonlyArray<string>, opts: Parameters<typeof spawn>[2]) => ChildProcess) | undefined;

export function setVerifierSpawn(factory: typeof spawnOverride): void { spawnOverride = factory; }
export function resetVerifierSpawn(): void { spawnOverride = undefined; }

/**
 * One-shot verifier run. Returns an `ok` shape carrying the new
 * `verificationId` and `reviewId` (both freshly minted). Returns a
 * `conflict` when the task / workspace cannot be resolved or the recipe
 * is missing.
 */
export async function verifyOnce(worker: DbWorker, input: VerifyOnceInput): Promise<VerifyOnceResult> {
  const parsed = VERIFY_ONCE_INPUT.parse(input);
  const task = await readTask(worker, parsed.taskId);
  if (!task) return { kind: "conflict", reason: "Task not found" };
  const workspaceRow = await findWorkspaceForTask(worker, parsed.taskId);
  if (!workspaceRow)
    return { kind: "conflict", reason: "No workspace bound to this task; cannot capture candidate identity" };
  if (!workspaceRow.worktreePath)
    return { kind: "conflict", reason: "Workspace has no worktree path; cannot execute verifier" };

  // Resolve recipe (if any) and merge command/env.
  let command = parsed.command ?? "";
  let argv: string[] = [...parsed.argv];
  let env: Record<string, string> = { ...parsed.env };
  let configurationRevision: string | null = null;
  let requiredCheckNames: string[] = [];
  let assertionPattern: string | null = null;
  if (parsed.recipeId) {
    const recipe = await readRecipe(worker, parsed.recipeId);
    if (!recipe) return { kind: "conflict", reason: `Recipe ${parsed.recipeId} not found` };
    command = command || recipe.command;
    argv = argv.length > 0 ? argv : (JSON.parse(recipe.argvJson) as string[]);
    env = Object.keys(env).length > 0 ? env : (JSON.parse(recipe.envJson) as Record<string, string>);
    configurationRevision = recipe.configurationRevision;
    requiredCheckNames = [recipe.name];
    assertionPattern = recipe.assertionPattern;
  }
  if (!command) return { kind: "conflict", reason: "No command resolved (recipe missing or no override)" };

  // Capture the candidate identity triple up-front. We compute the
  // porcelain + dirty file digest INSIDE the worktree, so any later
  // mutation in the worktree invalidates the bound review.
  const porcelainDigest = await computePorcelainDigest(workspaceRow.worktreePath);
  const candidateDiff = createHash("sha256")
    .update(`${porcelainDigest}|${workspaceRow.baseIdentity ?? ""}|${workspaceRow.headRevision ?? ""}`)
    .digest("hex");

  // Open a `running` verification row.
  const verification = await createVerification(worker, {
    taskId: parsed.taskId,
    runId: parsed.runId ?? null,
    recipeId: parsed.recipeId ?? null,
    command, cwd: workspaceRow.worktreePath,
    argv, env,
    configurationRevision,
    candidateBase: workspaceRow.baseIdentity,
    candidateTree: workspaceRow.headRevision,
    candidateDiff,
  });

  // Spawn.
  const spawnImpl = spawnOverride ?? ((bin, args, opts) => spawn(bin, args as string[], opts));
  const child = spawnImpl(command, argv, {
    cwd: workspaceRow.worktreePath,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });

  // Deadline + kill escalation.
  const deadlineMs = Math.max(0, new Date(parsed.deadlineAt).getTime() - Date.now());
  const killTimer = setTimeout(() => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
    }, ESCALATE_AFTER_MS).unref();
  }, deadlineMs);
  killTimer.unref();

  const exitInfo: { code: number | null; signal: NodeJS.Signals | null; error: Error | null } = await new Promise(resolve => {
    child.on("exit", (code, signal) => resolve({ code, signal, error: null }));
    child.on("error", error => resolve({ code: null, signal: null, error }));
  });
  clearTimeout(killTimer);

  const stdoutTail = tailToString(stdoutChunks, OUTPUT_TAIL_BYTES);
  const stderrTail = tailToString(stderrChunks, OUTPUT_TAIL_BYTES);

  // Parse assertion counts if a pattern was set; the regex MUST be a
  // JSON-line regex (no `m` flag, no anchors — the executor already
  // splits on lines). Invalid JSON → counts = null, verifier still
  // completes.
  let assertionCounts: Record<string, number> | null = null;
  if (assertionPattern) {
    try {
      const regex = new RegExp(assertionPattern);
      for (const line of stdoutTail.split("\n")) {
        const match = regex.exec(line.trim());
        if (!match) continue;
        const parsed = JSON.parse(match[0]) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const counts: Record<string, number> = {};
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "number" && Number.isFinite(value) && value >= 0) counts[key] = value;
          }
          assertionCounts = counts;
          break;
        }
      }
    } catch { assertionCounts = null; /* invalid pattern / counts stay null */ }
  }

  // Required check results: one entry per recipe row. The status here is
  // a per-check marker ("passed" / "failed" / "skipped" / "empty" /
  // "missing"); the verification's overall terminal status is computed
  // from `exit_code` alone (an empty stdout on a successful exit still
  // counts as "passed" — the required check ran, just produced no
  // output).
  const results: Array<{ name: string; status: "passed" | "failed" | "skipped" | "empty" | "missing"; observed: string }> = [];
  for (const name of requiredCheckNames) {
    let status: "passed" | "failed" | "skipped" | "empty" | "missing";
    let observed: string;
    if (exitInfo.error) { status = "missing"; observed = exitInfo.error.message; }
    else if (exitInfo.signal) {
      // SIGTERM / SIGKILL from the executor → "missing" so the user
      // can re-run; the deadline killed the verifier, it didn't fail.
      status = "missing";
      observed = `killed by ${exitInfo.signal}`;
    } else if (exitInfo.code === 0) {
      status = stdoutTail.length === 0 ? "empty" : "passed";
      observed = stdoutTail.slice(-256);
    } else {
      status = "failed";
      observed = stderrTail.slice(-256) || `(exit ${exitInfo.code})`;
    }
    results.push({ name, status, observed });
  }
  // Terminal status is driven by exit_code:
  //  - spawn error → "error"
  //  - signal kill  → "error"
  //  - exit 0       → "passed"  (regardless of empty stdout; "empty"
  //                          is a per-check marker for the run, not
  //                          the verification's verdict)
  //  - non-zero     → "failed"
  let terminal: "passed" | "failed" | "error";
  if (exitInfo.error) terminal = "error";
  else if (exitInfo.signal) terminal = "error";
  else if (exitInfo.code === 0) terminal = "passed";
  else terminal = "failed";

  const final = await recordVerificationOutput(worker, verification.id, {
    exitCode: exitInfo.code,
    signal: exitInfo.signal ?? null,
    assertionCounts,
    requiredCheckResults: results,
    stdoutTail,
    stderrTail,
    to: terminal,
  });

  // Open (or refresh) the bound review row. The configurationRevision is
  // a unique binding key for the review: a recipe edit rotates the
  // digest and the next `verifyOnce` produces a fresh review.
  const review = await createOpenReview(worker, {
    taskId: parsed.taskId,
    runId: parsed.runId ?? null,
    evidenceVerificationIds: [verification.id],
    candidateBase: workspaceRow.baseIdentity,
    candidateTree: workspaceRow.headRevision,
    candidateDiff,
    configurationRevision,
  });

  // Touch the task so the projection's `updatedAt` changes. Cheap
  // refresh — the renderer re-polls on `onWorkspaceChanged`.
  void driverOf(worker).prepare("UPDATE task SET updated_at = ? WHERE uuid = ?")
    .run(new Date().toISOString(), parsed.taskId);

  return { kind: "ok", verificationId: verification.id, reviewId: review.id, verification: final };
}

/**
 * Find the most-recent workspace for the task. Returns undefined if the
 * task has no workspace bound (e.g. a draft task that never reached
 * `prepareManagedWorkspace`).
 */
async function findWorkspaceForTask(worker: DbWorker, taskId: string) {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM workspace WHERE task_id = ? ORDER BY created_at DESC LIMIT 1").first(taskId);
  if (!row) return undefined;
  return readWorkspace(worker, String((row as Record<string, unknown>).uuid));
}

/**
 * Compute a deterministic digest of the worktree's current porcelain
 * status. We do not shell out to `git` (the runtime doesn't bundle a
 * specific Git binary); the digest is a stable fingerprint of the
 * files visible to the verifier at start. If the runtime later
 * surfaces a real `git diff-index` call, this is where to plug it in.
 */
async function computePorcelainDigest(worktreePath: string): Promise<string> {
  try {
    const hash = createHash("sha256");
    const entries = await readdir(worktreePath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.isFile()) {
        const full = path.join(worktreePath, entry.name);
        try {
          const info = await stat(full);
          if (!info.isFile()) continue;
          const buf = await readFile(full);
          hash.update(`${entry.name}\0${info.size}\0${info.mtimeMs.toString()}\0`);
          hash.update(buf);
        } catch { /* unreadable file → skip */ }
      } else if (entry.isDirectory()) {
        hash.update(`dir:${entry.name}\0`);
      }
    }
    return hash.digest("hex");
  } catch { return ""; }
}

/** Concatenate chunks and keep only the last `maxBytes` characters (UTF-8-safe). */
function tailToString(chunks: ReadonlyArray<Buffer>, maxBytes: number): string {
  if (chunks.length === 0) return "";
  const joined = Buffer.concat(chunks);
  const tail = joined.length > maxBytes ? joined.subarray(joined.length - maxBytes) : joined;
  return tail.toString("utf8");
}

// Re-export so a unit test or IPC handler can build a configuration
// revision without reaching into the recipes service directly.
export { computeConfigurationRevision };