/**
 * M3c.2 — `verification` entity service.
 *
 * A verification is one recorded execution of a verifier. The executor
 * (`src/runtime/orchestration/verifier-execute.ts`) inserts a `running`
 * row, fills in evidence as the verifier runs, and transitions to
 * `passed` / `failed` / `error`. The identity triple (candidate base,
 * tree, diff) is captured at start so the bound review is unforgeable.
 *
 * State machine:
 *   running → passed
 *           → failed
 *           → error
 * `passed` / `failed` / `error` are terminal. A verifier that completes
 * a `failed` check still records `failed`; a verifier that times out
 * (or never spawned) records `error`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { verificationRowSchema } from "./schema";
import { verificationStatusSchema, type Verification, type VerificationStatus } from "../../shared/managed";
import type { DbWorker } from "./worker";

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

const VERIFICATION_TRANSITIONS: Record<VerificationStatus, ReadonlyArray<VerificationStatus>> = {
  running: ["passed", "failed", "error"],
  passed: [],
  failed: [],
  error: [],
};

const createVerificationSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  recipeId: z.string().uuid().nullable().default(null),
  command: z.string().min(1).max(1024),
  cwd: z.string().min(1).max(1024),
  argv: z.array(z.string().min(1).max(1024)).default([]),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
  configurationRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  candidateBase: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  candidateTree: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  candidateDiff: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
}).strict();
export type CreateVerificationInput = z.input<typeof createVerificationSchema>;

export async function createVerification(worker: DbWorker, input: CreateVerificationInput): Promise<Verification> {
  const parsed = createVerificationSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO verification (uuid, task_id, run_id, recipe_id, command, cwd, argv_json, env_json, " +
      "configuration_revision, candidate_base, candidate_tree, candidate_diff, status, " +
      "exit_code, signal, started_at, ended_at, assertion_counts_json, required_check_results_json, " +
      "stdout_tail_json, stderr_tail_json, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.taskId, parsed.runId, parsed.recipeId,
      parsed.command, parsed.cwd,
      JSON.stringify(parsed.argv),
      JSON.stringify(parsed.env),
      parsed.configurationRevision,
      parsed.candidateBase, parsed.candidateTree, parsed.candidateDiff,
      "running", null, null, now, null,
      null, "[]", '""', '""', now, now,
    );
  });
  const read = await readVerification(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Verification disappeared after insert");
  return read;
}

export async function readVerification(worker: DbWorker, id: string): Promise<Verification | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM verification WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseVerificationRow(row);
}

export async function listVerificationsForTask(worker: DbWorker, taskId: string): Promise<Verification[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare(
    "SELECT * FROM verification WHERE task_id = ? ORDER BY created_at ASC",
  ).all(taskId);
  return rows.map(parseVerificationRow);
}

/** Flat list — used by the projection to read every verification in one pass. */
export async function listVerifications(worker: DbWorker): Promise<Verification[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM verification ORDER BY created_at ASC").all();
  return rows.map(parseVerificationRow);
}

export async function listVerificationsForRun(worker: DbWorker, runId: string): Promise<Verification[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare(
    "SELECT * FROM verification WHERE run_id = ? ORDER BY created_at ASC",
  ).all(runId);
  return rows.map(parseVerificationRow);
}

const TRANSITION_INPUT = z.object({
  to: verificationStatusSchema,
  exitCode: z.number().int().nullable().optional(),
  signal: z.string().min(1).max(32).nullable().optional(),
}).strict();
export type VerificationTransitionInput = z.input<typeof TRANSITION_INPUT>;

export async function transitionVerification(worker: DbWorker, id: string, input: VerificationTransitionInput): Promise<Verification> {
  const parsed = TRANSITION_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM verification WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Verification not found");
    const from = verificationStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!VERIFICATION_TRANSITIONS[from].includes(parsed.to))
      throw new AppError("CONFLICT", `Illegal verification transition ${from} → ${parsed.to}`);
    const now = new Date().toISOString();
    const updates: string[] = ["status = ?", "ended_at = ?"];
    const values: unknown[] = [parsed.to, now];
    if (parsed.exitCode !== undefined) { updates.push("exit_code = ?"); values.push(parsed.exitCode); }
    if (parsed.signal !== undefined) { updates.push("signal = ?"); values.push(parsed.signal); }
    updates.push("updated_at = ?"); values.push(now);
    values.push(id);
    driver.prepare(`UPDATE verification SET ${updates.join(", ")} WHERE uuid = ?`).run(...values);
  });
  const after = await readVerification(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Verification disappeared after transition");
  return after;
}

const RECORD_OUTPUT_INPUT = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(32).nullable(),
  assertionCounts: z.record(z.string().min(1).max(64), z.number().int().nonnegative()).nullable(),
  requiredCheckResults: z.array(z.object({
    name: z.string().min(1).max(200),
    status: z.enum(["passed", "failed", "skipped", "empty", "missing"]),
    observed: z.string().max(8 * 1024).optional(),
  })),
  stdoutTail: z.string().max(128 * 1024),
  stderrTail: z.string().max(128 * 1024),
  /** Terminal status — `passed` for exit 0 with all required checks `passed`, `failed` otherwise. */
  to: verificationStatusSchema,
}).strict();
export type RecordVerificationOutputInput = z.input<typeof RECORD_OUTPUT_INPUT>;

/**
 * Finalise a verification in a single transaction: write exit/signal,
 * assertion counts, required check results, bounded stdout/stderr
 * tails, and transition to the terminal status. Atomic so the
 * renderer always sees a complete row.
 */
export async function recordVerificationOutput(worker: DbWorker, id: string, input: RecordVerificationOutputInput): Promise<Verification> {
  const parsed = RECORD_OUTPUT_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM verification WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Verification not found");
    const from = verificationStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (from !== "running")
      throw new AppError("CONFLICT", `Verification already terminal (${from}); refusing to overwrite`);
    if (!VERIFICATION_TRANSITIONS.running.includes(parsed.to))
      throw new AppError("CONFLICT", `Illegal terminal status ${parsed.to}`);
    const now = new Date().toISOString();
    driver.prepare(
      "UPDATE verification SET exit_code = ?, signal = ?, ended_at = ?, " +
      "assertion_counts_json = ?, required_check_results_json = ?, " +
      "stdout_tail_json = ?, stderr_tail_json = ?, status = ?, updated_at = ? " +
      "WHERE uuid = ?",
    ).run(
      parsed.exitCode, parsed.signal, now,
      parsed.assertionCounts ? JSON.stringify(parsed.assertionCounts) : null,
      JSON.stringify(parsed.requiredCheckResults),
      JSON.stringify(parsed.stdoutTail),
      JSON.stringify(parsed.stderrTail),
      parsed.to, now, id,
    );
  });
  const after = await readVerification(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Verification disappeared after output record");
  return after;
}

function parseVerificationRow(row: Record<string, unknown>): Verification {
  const parsed = verificationRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    recipeId: row.recipe_id == null ? null : String(row.recipe_id),
    command: String(row.command),
    cwd: String(row.cwd),
    argvJson: String(row.argv_json ?? "[]"),
    envJson: String(row.env_json ?? "{}"),
    configurationRevision: row.configuration_revision == null ? null : String(row.configuration_revision),
    candidateBase: row.candidate_base == null ? null : String(row.candidate_base),
    candidateTree: row.candidate_tree == null ? null : String(row.candidate_tree),
    candidateDiff: row.candidate_diff == null ? null : String(row.candidate_diff),
    status: String(row.status),
    exitCode: row.exit_code == null ? null : Number(row.exit_code),
    signal: row.signal == null ? null : String(row.signal),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    assertionCountsJson: row.assertion_counts_json == null ? null : String(row.assertion_counts_json),
    requiredCheckResultsJson: String(row.required_check_results_json ?? "[]"),
    stdoutTailJson: String(row.stdout_tail_json ?? '""'),
    stderrTailJson: String(row.stderr_tail_json ?? '""'),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}