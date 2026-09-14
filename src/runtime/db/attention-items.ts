/**
 * M3a / M3c.3 — `attention_item` entity service.
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
 * M3c.3 widens `new → seen` so the snooze path can auto-mark a fresh
 * item as `seen` before writing the snooze deadline.
 *
 * `dismissed` and `resolved` are presentation terminals. The IMPLEMENTATION-
 * README bullet "read/snooze/dismiss presentation does not resolve
 * authority" means a newer-revision raise is the system-level signal that
 * the issue is still relevant. `resolved` is authority; only the system
 * that produced the row reaches it.
 *
 * M3c.3 also adds `snoozed_until` (durable presentation column). A `seen`
 * or `snoozed` row with `snoozed_until > now` is filtered out of the
 * open-attention inbox but the row stays in `snoozed` state until the
 * user explicitly transitions it.
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
  snoozed: ["seen", "snoozed", "dismissed", "resolved"],
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
        "payload_json, created_at, updated_at, snoozed_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id, parsed.taskId, parsed.kind, parsed.issueIdentity, parsed.revision, "new",
        JSON.stringify(parsed.payload), now, now, null,
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

/**
 * M3c.3 — open-attention inbox slice.
 *
 * "Open" = state ∈ {new, seen, snoozed} AND
 * (snoozed_until IS NULL OR snoozed_until <= now). Sorted by
 * `updated_at DESC` so the most-recent surfaces first; the inbox
 * groups them by (kind, issueIdentity) in the renderer.
 */
export async function listOpenAttention(
  worker: DbWorker,
  now: Date = new Date(),
): Promise<AttentionItem[]> {
  const driver = driverOf(worker);
  const nowIso = now.toISOString();
  return driver.prepare("SELECT * FROM attention_item").all()
    .map(parseAttentionRow)
    .filter(item => {
      if (item.state === "dismissed" || item.state === "resolved") return false;
      if (item.snoozedUntil && item.snoozedUntil > nowIso) return false;
      return true;
    })
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

const snoozeSchema = z.object({
  id: z.string().uuid(),
  until: z.date(),
}).strict();
export type SnoozeAttentionInput = z.input<typeof snoozeSchema>;

/**
 * M3c.3 — durable snooze. Atomically writes `snoozed_until` AND
 * transitions the row to `snoozed` so the projection reflects the
 * change in a single projection pass. Auto-marks a `new` row as
 * `seen` first (FSM widening — `new → seen` was already legal for
 * the standard mark-seen path; the snooze path reuses it so the
 * renderer doesn't have to issue two calls). Re-snooze overwrites
 * the existing deadline.
 *
 * Refuses `until <= now` with `INVALID_REQUEST` — a zero-duration
 * snooze is a no-op the user almost certainly didn't intend.
 */
export async function snoozeAttention(worker: DbWorker, input: SnoozeAttentionInput): Promise<AttentionItem> {
  const parsed = snoozeSchema.parse(input);
  const now = new Date();
  if (parsed.until.getTime() <= now.getTime())
    throw new AppError("INVALID_REQUEST", "Snooze deadline must be strictly in the future");
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT state FROM attention_item WHERE uuid = ?").first(parsed.id);
    if (!row) throw new AppError("NOT_FOUND", "Attention item not found");
    const from = attentionStateSchema.parse(String((row as Record<string, unknown>).state));
    // `new → seen` is the auto-mark path; `seen → snoozed` and
    // `snoozed → snoozed` (re-snooze) are direct edges in the FSM.
    if (from === "new") {
      driver.prepare("UPDATE attention_item SET state = ?, updated_at = ? WHERE uuid = ?")
        .run("seen", new Date().toISOString(), parsed.id);
    } else if (!ATTENTION_TRANSITIONS[from].includes("snoozed")) {
      throw new AppError("CONFLICT", `Illegal attention transition ${from} → snoozed`);
    }
    driver.prepare("UPDATE attention_item SET state = ?, snoozed_until = ?, updated_at = ? WHERE uuid = ?")
      .run("snoozed", parsed.until.toISOString(), new Date().toISOString(), parsed.id);
    void tx;
  });
  const after = await readAttention(worker, parsed.id);
  if (!after) throw new AppError("UNAVAILABLE", "Attention item disappeared after snooze");
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
    snoozedUntil: row.snoozed_until == null ? null : String(row.snoozed_until),
  });
  return { ...parsed, id: parsed.uuid };
}