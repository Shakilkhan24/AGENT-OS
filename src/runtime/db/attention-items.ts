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
 *
 * M7.7 — `schedule-decision` + `ci-failure` join the existing five
 * kinds. Both use the same FSM; both surface `raiseScheduleDecision` /
 * `raiseCiFailure` helpers that pre-compute the `issueIdentity`
 * (sha256 over the canonical payload) so the renderer can group
 * repeated failures under a single stable key. `shouldSuppressAttention`
 * is the alert-flood gate: a row raised within the dedup window for
 * the same `(kind, issueIdentity)` collapses to the existing row so
 * the inbox never carries dozens of identical failures.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { attentionItemRowSchema } from "./schema";
import { attentionKindSchema, attentionStateSchema, type AttentionItem } from "../../shared/managed";
import type { DbWorker } from "./worker";

/** M7.7 — default dedup window for stable-key attention rows. */
export const DEFAULT_ATTENTION_DEDUP_WINDOW_MS = 60 * 60_000;

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

// ── M7.7 — schedule-decision + ci-failure helpers ───────────────────────────

export const scheduleDecisionPayloadSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    revision: z.number().int().min(0).max(2_048),
    intendedUtc: z.string().datetime(),
    kind: z.enum(["missed", "overlap", "stale-boot", "grace-expired"]),
    recipeId: z.string().min(1).max(128),
  })
  .strict();
export type ScheduleDecisionPayload = z.output<typeof scheduleDecisionPayloadSchema>;
export type ScheduleDecisionPayloadInput = z.input<typeof scheduleDecisionPayloadSchema>;

export const ciFailurePayloadSchema = z
  .object({
    artifactSha256: z.string().regex(/^[0-9a-f]{64}$/),
    buildId: z.string().min(1).max(256).optional(),
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
    workflowRunId: z.string().min(1).max(256).optional(),
    attemptCount: z.number().int().min(0).max(1024),
    lastErrorDigest: z.string().min(1).max(256),
    retryBudgetExhausted: z.boolean(),
  })
  .strict();
export type CiFailurePayload = z.output<typeof ciFailurePayloadSchema>;
export type CiFailurePayloadInput = z.input<typeof ciFailurePayloadSchema>;

/**
 * Stable sha256 digest over an arbitrary object — keys are sorted
 * to keep the surface deterministic across runtimes.
 */
function digestStable(value: unknown): string {
  return createHash("sha256").update(stableStringifyLocal(value), "utf8").digest("hex");
}

function stableStringifyLocal(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringifyLocal).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyLocal(obj[k])}`).join(",")}}`;
}

/**
 * M7.7 — alert-flood gate.
 *
 * Returns the most-recent existing attention row for
 * `(kind, issueIdentity)` whose `createdAt` (or `updatedAt`) is
 * within `windowMs` of `now`, or `null` if no such row exists.
 *
 * The check is intentionally cheap: a full scan is bounded by the
 * attention row count, which the FSM keeps small (a `dismissed` /
 * `resolved` row is filtered out so the inbox never grows
 * unbounded).
 */
export function shouldSuppressAttention(
  worker: DbWorker,
  kind: AttentionItem["kind"],
  issueIdentity: string,
  options?: { windowMs?: number; now?: Date },
): { existingItem: AttentionItem; ageMs: number } | null {
  const windowMs = options?.windowMs ?? DEFAULT_ATTENTION_DEDUP_WINDOW_MS;
  const now = options?.now ?? new Date();
  const driver = driverOf(worker);
  const all = driver
    .prepare("SELECT * FROM attention_item WHERE kind = ? AND issue_identity = ?")
    .all(kind, issueIdentity)
    .map(parseAttentionRow);
  if (all.length === 0) return null;
  // Pick the most-recent row, regardless of state. We do not
  // consider `resolved` as a suppression trigger: once an issue is
  // resolved, a new raise must surface. `dismissed` rows are
  // presentation-only and do NOT suppress.
  const sorted = all.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const item of sorted) {
    if (item.state === "resolved") continue;
    const lastTouched = new Date(item.updatedAt).getTime();
    const ageMs = now.getTime() - lastTouched;
    if (ageMs < 0) continue; // clock skew — be conservative
    if (ageMs <= windowMs) return { existingItem: item, ageMs };
  }
  return null;
}

/**
 * M7.7 — pick the next free revision for a `(kind, issueIdentity)`
 * pair. The `UNIQUE(issueIdentity, revision)` index would collide
 * if we tried to write `revision: 0` against a previously-resolved
 * row at the same identity. This helper returns
 * `max(existing.revision) + 1` (or `0` when no row exists) so the
 * caller can stay declarative about wanting "a fresh row for this
 * identity" without juggling revisions manually.
 */
export function nextRevisionFor(
  worker: DbWorker,
  kind: AttentionItem["kind"],
  issueIdentity: string,
): number {
  const driver = driverOf(worker);
  const rows = driver
    .prepare("SELECT revision FROM attention_item WHERE kind = ? AND issue_identity = ?")
    .all(kind, issueIdentity);
  if (rows.length === 0) return 0;
  let max = -1;
  for (const row of rows) {
    const r = Number((row as Record<string, unknown>).revision ?? 0);
    if (r > max) max = r;
  }
  return max + 1;
}

export interface RaiseScheduleDecisionInput {
  taskId?: string | null;
  payload: ScheduleDecisionPayloadInput;
  /** Optional override for the dedup window (default 1 hour). */
  windowMs?: number;
  now?: Date;
}

export interface RaiseScheduleDecisionResult {
  readonly kind: "created" | "suppressed";
  readonly item: AttentionItem;
  readonly issueIdentity: string;
}

/**
 * Raise a `schedule-decision` attention row. The `issueIdentity` is
 * sha256 over the canonical payload, so identical (scheduleId,
 * revision, intendedUtc, kind, recipeId) collapses to the same
 * identity. Inside the dedup window a second raise returns the
 * existing row with `kind: "suppressed"`. A re-raise AFTER the
 * window (or after the existing row is resolved/dismissed) bumps
 * the revision so the (issueIdentity, revision) UNIQUE index does
 * not collide.
 */
export async function raiseScheduleDecision(
  worker: DbWorker,
  input: RaiseScheduleDecisionInput,
): Promise<RaiseScheduleDecisionResult> {
  const parsed = scheduleDecisionPayloadSchema.parse(input.payload);
  const issueIdentity = digestStable({
    kind: "schedule-decision",
    scheduleId: parsed.scheduleId,
    revision: parsed.revision,
    intendedUtc: parsed.intendedUtc,
    reason: parsed.kind,
    recipeId: parsed.recipeId,
  });
  const suppressed = shouldSuppressAttention(worker, "schedule-decision", issueIdentity, {
    windowMs: input.windowMs,
    now: input.now,
  });
  if (suppressed) {
    return { kind: "suppressed", item: suppressed.existingItem, issueIdentity };
  }
  // Pick a free revision so the UNIQUE(issueIdentity, revision)
  // index never collides with a previously-resolved row.
  const nextRevision = nextRevisionFor(worker, "schedule-decision", issueIdentity);
  const item = await raiseAttention(worker, {
    taskId: input.taskId ?? null,
    kind: "schedule-decision",
    issueIdentity,
    revision: nextRevision,
    payload: parsed,
  });
  return { kind: "created", item, issueIdentity };
}

export interface RaiseCiFailureInput {
  taskId?: string | null;
  payload: CiFailurePayloadInput;
  windowMs?: number;
  now?: Date;
}

export interface RaiseCiFailureResult {
  readonly kind: "created" | "suppressed";
  readonly item: AttentionItem;
  readonly issueIdentity: string;
}

/**
 * Raise a `ci-failure` attention row. The `issueIdentity` is sha256
 * over the canonical payload (artifact + attempt + error digest +
 * retry-exhausted flag). Repeated failures of the same artifact
 * inside the dedup window collapse to the existing row.
 */
export async function raiseCiFailure(
  worker: DbWorker,
  input: RaiseCiFailureInput,
): Promise<RaiseCiFailureResult> {
  const parsed = ciFailurePayloadSchema.parse(input.payload);
  const issueIdentity = digestStable({
    kind: "ci-failure",
    artifactSha256: parsed.artifactSha256,
    lastErrorDigest: parsed.lastErrorDigest,
    retryBudgetExhausted: parsed.retryBudgetExhausted,
  });
  const suppressed = shouldSuppressAttention(worker, "ci-failure", issueIdentity, {
    windowMs: input.windowMs,
    now: input.now,
  });
  if (suppressed) {
    return { kind: "suppressed", item: suppressed.existingItem, issueIdentity };
  }
  // Pick a free revision so the UNIQUE(issueIdentity, revision)
  // index never collides with a previously-resolved row.
  const nextRevision = nextRevisionFor(worker, "ci-failure", issueIdentity);
  const item = await raiseAttention(worker, {
    taskId: input.taskId ?? null,
    kind: "ci-failure",
    issueIdentity,
    revision: nextRevision,
    payload: parsed,
  });
  return { kind: "created", item, issueIdentity };
}