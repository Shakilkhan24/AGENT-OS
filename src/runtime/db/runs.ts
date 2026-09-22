/**
 * M3a — `run` entity service.
 *
 * A run is one execution of a task. It carries the task's identity forward
 * (so a reconnecting peer can prove what it was doing) plus a status
 * state machine. A run can exist without a terminal — the renderer can
 * create a run for a task that doesn't have one yet, and the dispatch
 * subsystem attaches a terminal later via `attachTerminal`.
 *
 * The status state machine:
 *   queued → running → completed
 *                   → cancelled
 *                   → failed
 *
 * `cancelled` and `failed` are reachable from `running` (in-flight loss) or
 * `queued` (never admitted). `completed` is reachable only from `running`.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { runRowSchema } from "./schema";
import { runStatusSchema, type Run, type RunStatus } from "../../shared/managed";
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

const RUN_TRANSITIONS: Record<RunStatus, ReadonlyArray<RunStatus>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

const createRunSchema = z.object({
  taskId: z.string().uuid(),
  baseRevision: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
}).strict();
export type CreateRunInput = z.input<typeof createRunSchema>;

export async function createRun(worker: DbWorker, input: CreateRunInput): Promise<Run> {
  const parsed = createRunSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const taskExists = driver.prepare("SELECT uuid FROM task WHERE uuid = ?").first(parsed.taskId);
    if (!taskExists) throw new AppError("NOT_FOUND", "Task not found");
    driver.prepare(
      "INSERT INTO run (uuid, task_id, status, started_at, ended_at, base_revision, terminal_uuid, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, parsed.taskId, "queued", null, null, parsed.baseRevision, null, now, now);
  });
  const read = await readRun(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Run disappeared after insert");
  return read;
}

export async function readRun(worker: DbWorker, id: string): Promise<Run | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM run WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseRunRow(row);
}

export async function listRunsForTask(worker: DbWorker, taskId: string): Promise<Run[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM run WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
  return rows.map(parseRunRow);
}

const RUN_TRANSITION_INPUT = z.object({
  to: runStatusSchema,
}).strict();

export async function transitionRun(worker: DbWorker, id: string, to: RunStatus): Promise<Run> {
  const parsed = RUN_TRANSITION_INPUT.parse({ to });
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM run WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Run not found");
    const from = runStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!RUN_TRANSITIONS[from].includes(parsed.to))
      throw new AppError("CONFLICT", `Illegal run transition ${from} → ${parsed.to}`);
    const now = new Date().toISOString();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const values: unknown[] = [parsed.to, now];
    if (parsed.to === "running" && from === "queued") { updates.push("started_at = ?"); values.push(now); }
    if (parsed.to === "completed" || parsed.to === "cancelled" || parsed.to === "failed") {
      updates.push("ended_at = ?"); values.push(now);
    }
    values.push(id);
    driver.prepare(`UPDATE run SET ${updates.join(", ")} WHERE uuid = ?`).run(...values);
  });
  const after = await readRun(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Run disappeared after transition");
  return after;
}

export async function attachTerminal(worker: DbWorker, runId: string, terminalUuid: string): Promise<Run> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM run WHERE uuid = ?").first(runId);
    if (!row) throw new AppError("NOT_FOUND", "Run not found");
    driver.prepare("UPDATE run SET terminal_uuid = ?, updated_at = ? WHERE uuid = ?")
      .run(terminalUuid, new Date().toISOString(), runId);
  });
  const after = await readRun(worker, runId);
  if (!after) throw new AppError("UNAVAILABLE", "Run disappeared after terminal attach");
  return after;
}

function parseRunRow(row: Record<string, unknown>): Run {
  const parsed = runRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: String(row.task_id),
    status: String(row.status),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    baseRevision: row.base_revision == null ? null : String(row.base_revision),
    terminalUuid: row.terminal_uuid == null ? null : String(row.terminal_uuid),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}
