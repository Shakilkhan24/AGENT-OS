/**
 * M3a — `attention_item` entity service.
 *
 * An attention item is a reviewable issue a renderer must surface. Each item
 * is keyed by `(issueIdentity, revision)` so the same issue at a newer
 * revision is a fresh row (the dedupe rule lives in the renderer: read/
 * snooze/dismiss presentation does not resolve authority).
 *
 * The state machine:
 *   new → seen → snoozed → dismissed → resolved
 *
 * `resolved` is reachable from any state; `snoozed` is only from `seen`.
 * A `new` item with the same `revision` cannot be inserted (the unique
 * index refuses it) — the caller must update the row instead.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { attentionItemRowSchema } from "./schema";
import { attentionKindSchema, attentionStateSchema, type AttentionItem } from "../../shared/managed";
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

const ATTENTION_TRANSITIONS: Record<AttentionItem["state"], ReadonlyArray<AttentionItem["state"]>> = {
  new: ["seen", "resolved"],
  seen: ["snoozed", "dismissed", "resolved"],
  snoozed: ["seen", "dismissed", "resolved"],
  dismissed: ["resolved"],
  resolved: [],
};

const raiseSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  kind: attentionKindSchema,
  issueIdentity: z.string().min(1).max(256),
  revision: z.number().int().min(0).max(1024),
  payload: z.unknown().default({}),
}).strict();
export type RaiseAttentionInput = z.input<typeof raiseSchema>;

export async function raiseAttention(worker: DbWorker, input: RaiseAttentionInput): Promise<AttentionItem> {
  const parsed = raiseSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  try {
    await worker.transaction(tx => {
      void tx;
      driver.prepare(
        "INSERT INTO attention_item (uuid, task_id, kind, issue_identity, revision, state, " +
        "payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id, parsed.taskId, parsed.kind, parsed.issueIdentity, parsed.revision, "new",
        JSON.stringify(parsed.payload), now, now,
      );
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/UNIQUE/.test(message))
      throw new AppError("CONFLICT", `An attention_item for ${parsed.issueIdentity}@r${parsed.revision} already exists`);
    throw error;
  }
  const read = await readAttention(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Attention item disappeared after insert");
  return read;
}

export async function readAttention(worker: DbWorker, id: string): Promise<AttentionItem | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM attention_item WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseAttentionRow(row);
}

export async function listAttention(worker: DbWorker, filter?: { state?: AttentionItem["state"]; taskId?: string }): Promise<AttentionItem[]> {
  const driver = driverOf(worker);
  return driver.prepare("SELECT * FROM attention_item").all()
    .map(parseAttentionRow)
    .filter(item => {
      if (filter?.state && item.state !== filter.state) return false;
      if (filter?.taskId && item.taskId !== filter.taskId) return false;
      return true;
    });
}

export async function transitionAttention(worker: DbWorker, id: string, to: AttentionItem["state"]): Promise<AttentionItem> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT state FROM attention_item WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Attention item not found");
    const from = attentionStateSchema.parse(String((row as Record<string, unknown>).state));
    if (!ATTENTION_TRANSITIONS[from].includes(to))
      throw new AppError("CONFLICT", `Illegal attention transition ${from} → ${to}`);
    driver.prepare("UPDATE attention_item SET state = ?, updated_at = ? WHERE uuid = ?")
      .run(to, new Date().toISOString(), id);
  });
  const after = await readAttention(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Attention item disappeared after transition");
  return after;
}

function parseAttentionRow(row: Record<string, unknown>): AttentionItem {
  const parsed = attentionItemRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    kind: String(row.kind),
    issueIdentity: String(row.issue_identity),
    revision: Number(row.revision ?? 0),
    state: String(row.state),
    payloadJson: String(row.payload_json ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}