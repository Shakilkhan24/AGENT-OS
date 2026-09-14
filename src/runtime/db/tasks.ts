/**
 * M3a — `task` entity service.
 *
 * The task is the durable unit of work the user wants done. It exists
 * independent of any run; a task can be `draft`, `ready`, `active`, `done`,
 * or `abandoned`. The status state machine is enforced here: any transition
 * not on the legal list raises `CONFLICT` so a caller can never silently
 * regress a completed task.
 *
 * Identity fields (providerVersion, model, accountMode, hostId,
 * baseIdentity, rootIdentity) are captured on creation and immutable until
 * a follow-on `setTaskIdentity` call — the caller is expected to record
 * a `dispatch_intent` whenever those change.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import {
  taskStatusSchema,
  type Task,
  type TaskStatus,
} from "../../shared/managed";
import { taskRowSchema } from "./schema";
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

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlyArray<TaskStatus>> = {
  draft: ["ready", "abandoned"],
  ready: ["active", "abandoned"],
  active: ["done", "abandoned"],
  done: [],
  abandoned: [],
};

const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(8000).default(""),
  projectId: z.string().max(256).default(""),
  providerVersion: z.string().min(1).max(256).nullable().default(null),
  model: z.string().min(1).max(256).nullable().default(null),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable().default(null),
  hostId: z.string().min(1).max(128),
  baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  rootIdentity: z.string().regex(/^\d+:\d+$/).nullable().default(null),
  effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable().default(null),
}).strict();
export type TaskCreateInput = z.input<typeof taskCreateSchema>;

export interface CreatedTask { id: string; task: Task }

export async function createTask(worker: DbWorker, input: TaskCreateInput): Promise<CreatedTask> {
  const parsed = taskCreateSchema.parse(input);
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  const id = randomUUID();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO task (uuid, title, objective, status, project_id, provider_version, model, " +
      "account_mode, host_id, base_identity, root_identity, effective_inputs_json, " +
      "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.title, parsed.objective, "draft", parsed.projectId,
      parsed.providerVersion, parsed.model, parsed.accountMode, parsed.hostId,
      parsed.baseIdentity, parsed.rootIdentity,
      parsed.effectiveInputs ? JSON.stringify(parsed.effectiveInputs) : null,
      now, now,
    );
  });
  const read = await readTask(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Task disappeared after insert");
  return { id, task: read };
}

export async function readTask(worker: DbWorker, id: string): Promise<Task | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM task WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseTaskRow(row);
}

export async function listTasks(worker: DbWorker, filter?: { status?: TaskStatus; projectId?: string }): Promise<Task[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM task").all();
  return rows
    .map(parseTaskRow)
    .filter(task => {
      if (filter?.status && task.status !== filter.status) return false;
      if (filter?.projectId && task.projectId !== filter.projectId) return false;
      return true;
    });
}

const TASK_TRANSITION_INPUT = z.object({
  to: taskStatusSchema,
}).strict();
export type TaskTransitionInput = z.input<typeof TASK_TRANSITION_INPUT>;

export async function transitionTask(worker: DbWorker, id: string, input: TaskTransitionInput): Promise<Task> {
  const parsed = TASK_TRANSITION_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM task WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Task not found");
    const from = taskStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!TASK_TRANSITIONS[from].includes(parsed.to))
      throw new AppError("CONFLICT", `Illegal task transition ${from} → ${parsed.to}`);
    driver.prepare("UPDATE task SET status = ?, updated_at = ? WHERE uuid = ?")
      .run(parsed.to, new Date().toISOString(), id);
  });
  const after = await readTask(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Task disappeared after transition");
  return after;
}

const SET_IDENTITY_INPUT = z.object({
  providerVersion: z.string().min(1).max(256).nullable().optional(),
  model: z.string().min(1).max(256).nullable().optional(),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable().optional(),
  baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional(),
  rootIdentity: z.string().regex(/^\d+:\d+$/).nullable().optional(),
  effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable().optional(),
}).strict();
export type SetTaskIdentityInput = z.input<typeof SET_IDENTITY_INPUT>;

/** Set one or more identity fields. Refuses if the task is already in a terminal state. */
export async function setTaskIdentity(worker: DbWorker, id: string, input: SetTaskIdentityInput): Promise<Task> {
  const parsed = SET_IDENTITY_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM task WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Task not found");
    const status = taskStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (status === "done" || status === "abandoned")
      throw new AppError("CONFLICT", `Cannot change identity of ${status} task`);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (parsed.providerVersion !== undefined) { updates.push("provider_version = ?"); values.push(parsed.providerVersion); }
    if (parsed.model !== undefined) { updates.push("model = ?"); values.push(parsed.model); }
    if (parsed.accountMode !== undefined) { updates.push("account_mode = ?"); values.push(parsed.accountMode); }
    if (parsed.baseIdentity !== undefined) { updates.push("base_identity = ?"); values.push(parsed.baseIdentity); }
    if (parsed.rootIdentity !== undefined) { updates.push("root_identity = ?"); values.push(parsed.rootIdentity); }
    if (parsed.effectiveInputs !== undefined) {
      updates.push("effective_inputs_json = ?");
      values.push(parsed.effectiveInputs ? JSON.stringify(parsed.effectiveInputs) : null);
    }
    if (updates.length === 0) return;
    updates.push("updated_at = ?");
    values.push(new Date().toISOString());
    values.push(id);
    driver.prepare(`UPDATE task SET ${updates.join(", ")} WHERE uuid = ?`).run(...values);
  });
  const after = await readTask(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Task disappeared after identity update");
  return after;
}

function parseTaskRow(row: Record<string, unknown>): Task {
  const raw = taskRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    title: String(row.title),
    objective: String(row.objective ?? ""),
    status: String(row.status),
    projectId: String(row.project_id ?? ""),
    providerVersion: row.provider_version == null ? null : String(row.provider_version),
    model: row.model == null ? null : String(row.model),
    accountMode: row.account_mode == null ? null : String(row.account_mode),
    hostId: String(row.host_id ?? ""),
    baseIdentity: row.base_identity == null ? null : String(row.base_identity),
    rootIdentity: row.root_identity == null ? null : String(row.root_identity),
    effectiveInputs: row.effective_inputs_json == null
      ? null
      : JSON.parse(String(row.effective_inputs_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  // The row schema's `id` and `uuid` overlap; the shared `taskSchema.id` is the
  // canonical public id.
  return { ...raw, id: raw.uuid } as Task;
}
