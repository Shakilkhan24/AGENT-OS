/**
 * M3a — `workspace` entity service.
 *
 * A workspace is the working directory bound to a task: either a Git
 * worktree (`git-worktree`) or a recoverable snapshot (`snapshot`). The
 * workspace row records where the work happens, the base commit, and the
 * current head; the `lease_id` is set by the lease service when a writer
 * acquires the workspace.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { workspaceRowSchema } from "./schema";
import { workspaceKindSchema, type Workspace } from "../../shared/managed";
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

const createWorkspaceSchema = z.object({
  taskId: z.string().uuid(),
  kind: workspaceKindSchema,
  location: z.string().min(1).max(1024),
  baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  worktreePath: z.string().min(1).max(1024).nullable().default(null),
  headRevision: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
}).strict();
export type CreateWorkspaceInput = z.input<typeof createWorkspaceSchema>;

export async function createWorkspace(worker: DbWorker, input: CreateWorkspaceInput): Promise<Workspace> {
  const parsed = createWorkspaceSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const taskExists = driver.prepare("SELECT uuid FROM task WHERE uuid = ?").first(parsed.taskId);
    if (!taskExists) throw new AppError("NOT_FOUND", "Task not found");
    driver.prepare(
      "INSERT INTO workspace (uuid, task_id, kind, location, base_identity, worktree_path, " +
      "head_revision, lease_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.taskId, parsed.kind, parsed.location,
      parsed.baseIdentity, parsed.worktreePath, parsed.headRevision, null, now,
    );
  });
  const read = await readWorkspace(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Workspace disappeared after insert");
  return read;
}

export async function readWorkspace(worker: DbWorker, id: string): Promise<Workspace | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM workspace WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseWorkspaceRow(row);
}

export async function setHeadRevision(worker: DbWorker, id: string, head: string): Promise<Workspace> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT uuid FROM workspace WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Workspace not found");
    driver.prepare("UPDATE workspace SET head_revision = ? WHERE uuid = ?").run(head, id);
  });
  const after = await readWorkspace(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Workspace disappeared after head update");
  return after;
}

export async function setWorkspaceLease(worker: DbWorker, id: string, leaseId: string | null): Promise<Workspace> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT uuid FROM workspace WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Workspace not found");
    driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ?").run(leaseId, id);
  });
  const after = await readWorkspace(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Workspace disappeared after lease update");
  return after;
}

export async function listWorkspacesForTask(worker: DbWorker, taskId: string): Promise<Workspace[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM workspace WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
  return rows.map(parseWorkspaceRow);
}

function parseWorkspaceRow(row: Record<string, unknown>): Workspace {
  const parsed = workspaceRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: String(row.task_id),
    kind: String(row.kind),
    location: String(row.location),
    baseIdentity: row.base_identity == null ? null : String(row.base_identity),
    worktreePath: row.worktree_path == null ? null : String(row.worktree_path),
    headRevision: row.head_revision == null ? null : String(row.head_revision),
    leaseId: row.lease_id == null ? null : String(row.lease_id),
    createdAt: String(row.created_at),
  });
  return { ...parsed, id: parsed.uuid };
}