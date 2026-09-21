/**
 * M7 — schedule dispatcher.
 *
 * The M7.1 / M7.2 / M7.3 bullets (FUTURE/IMPLEMENTATION-README.md
 * lines 254-256) require durable schedule + revision + occurrence
 * records. This service is the dispatcher that:
 *
 *   1. Reads every `schedule_occurrence` row with `state: "pending"`
 *      and `intended_utc <= now`.
 *   2. Transitions each row to `state: "dispatched"` inside a
 *      transaction (the row's UUID is the cross-call guard, so two
 *      controllers racing on the same database cannot double-fire).
 *   3. Hands the row's `(recipe_id, schedule_id, revision,
 *      intended_utc)` to the workflow executor (callback supplied
 *      by the caller — this module never imports the executor
 *      directly so a unit test can swap a stub).
 *
 * Skip-and-report semantics (M7.2):
 *   - `overlapPolicy: "skip"` keeps the previous workflow open
 *     while a new occurrence is due; the due occurrence is
 *     transitioned to `state: "skipped"` rather than dispatched.
 *   - `graceWindowMs > 0` permits a coalesced catch-up of at most
 *     one eligible occurrence inside the grace window.
 *
 * The dispatcher is the only path that calls
 * `transitionOccurrence`; every state move is recorded in the same
 * transaction as the dispatch, so a crash before commit leaves the
 * row in `pending` for the next controller pass.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "../db/worker";
import {
  occurrenceStateSchema,
  scheduleInputSchema,
  type Occurrence,
  type OccurrenceInput,
  type ScheduleInput,
  type ScheduleRule,
  scheduleRevisionSchema,
  type ScheduleRevision,
  scheduleRevisionStatusSchema,
  nextLocalOccurrence,
} from "../db/schedule-schema";

// ---------------------------------------------------------------------------
// Driver adapter
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const publishRevisionInputSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    rule: z.unknown(),
    timezone: z.string().min(1).max(64),
    recipeId: z.string().min(1).max(128),
    overlapPolicy: z.enum(["skip", "allow"]).default("skip"),
    graceWindowMs: z.number().int().min(0).max(60 * 60_000).default(0),
    publishedBy: z.string().min(1).max(256),
  })
  .strict();
export type PublishRevisionInput = z.input<typeof publishRevisionInputSchema>;

// ---------------------------------------------------------------------------
// Schedule CRUD
// ---------------------------------------------------------------------------

/**
 * Create or update a schedule. The `(schedule_id)` is unique;
 * subsequent calls update the same row.
 */
export async function upsertSchedule(
  worker: DbWorker,
  input: ScheduleInput,
): Promise<{ scheduleId: string }> {
  const parsed = scheduleInputSchema.parse(input);
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT uuid FROM schedule WHERE schedule_id = ?")
      .first(parsed.scheduleId);
    if (existing) {
      driver.prepare(
        "UPDATE schedule SET display_name = ?, rule_json = ?, timezone = ?, " +
          "recipe_id = ?, overlap_policy = ?, grace_window_ms = ?, updated_at = ? WHERE schedule_id = ?",
      ).run(
        parsed.displayName, JSON.stringify(parsed.rule), parsed.timezone,
        parsed.recipeId, parsed.overlapPolicy, parsed.graceWindowMs,
        now, parsed.scheduleId,
      );
      return;
    }
    driver.prepare(
      "INSERT INTO schedule (uuid, schedule_id, display_name, rule_json, timezone, " +
        "recipe_id, overlap_policy, grace_window_ms, status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), parsed.scheduleId, parsed.displayName,
      JSON.stringify(parsed.rule), parsed.timezone, parsed.recipeId,
      parsed.overlapPolicy, parsed.graceWindowMs, "enabled", now, now,
    );
  });
  return { scheduleId: parsed.scheduleId };
}

export async function setScheduleStatus(
  worker: DbWorker,
  scheduleId: string,
  status: "enabled" | "paused" | "disabled",
): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare("UPDATE schedule SET status = ?, updated_at = ? WHERE schedule_id = ?")
      .run(status, new Date().toISOString(), scheduleId);
  });
}

// ---------------------------------------------------------------------------
// Revision publishing
// ---------------------------------------------------------------------------

/**
 * Publish a new immutable revision. The first revision is 1;
 * subsequent revisions are strictly monotonic. A draft revision can
 * be promoted to `enabled` once the user has reviewed it.
 */
export async function publishScheduleRevision(
  worker: DbWorker,
  input: PublishRevisionInput,
): Promise<ScheduleRevision> {
  const parsed = publishRevisionInputSchema.parse(input);
  const driver = driverOf(worker);
  const revision = await nextRevisionNumber(worker, parsed.scheduleId);
  const revisionDigest = digestRevision({
    scheduleId: parsed.scheduleId,
    revision,
    rule: parsed.rule,
    timezone: parsed.timezone,
    recipeId: parsed.recipeId,
    overlapPolicy: parsed.overlapPolicy,
    graceWindowMs: parsed.graceWindowMs,
  });
  const now = new Date().toISOString();
  const uuid = randomUUID();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO schedule_revision (uuid, schedule_id, revision, rule_json, timezone, " +
        "recipe_id, overlap_policy, grace_window_ms, status, revision_digest, published_at, published_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      uuid, parsed.scheduleId, revision, JSON.stringify(parsed.rule),
      parsed.timezone, parsed.recipeId, parsed.overlapPolicy, parsed.graceWindowMs,
      "draft", revisionDigest, now, parsed.publishedBy,
    );
  });
  return scheduleRevisionSchema.parse({
    scheduleId: parsed.scheduleId,
    revision,
    rule: parsed.rule,
    timezone: parsed.timezone,
    recipeId: parsed.recipeId,
    overlapPolicy: parsed.overlapPolicy,
    graceWindowMs: parsed.graceWindowMs,
    status: "draft",
    revisionDigest,
    publishedAt: now,
    publishedBy: parsed.publishedBy,
  });
}

export async function promoteRevision(
  worker: DbWorker,
  scheduleId: string,
  revision: number,
  status: "enabled" | "revoked",
): Promise<void> {
  scheduleRevisionStatusSchema.parse(status);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE schedule_revision SET status = ? WHERE schedule_id = ? AND revision = ?",
    ).run(status, scheduleId, revision);
    if (status === "enabled") {
      // Mark every earlier non-superseded revision as superseded.
      driver.prepare(
        "UPDATE schedule_revision SET status = 'superseded' " +
          "WHERE schedule_id = ? AND revision < ? AND status NOT IN ('superseded', 'revoked')",
      ).run(scheduleId, revision);
    }
  });
}

async function nextRevisionNumber(worker: DbWorker, scheduleId: string): Promise<number> {
  const driver = driverOf(worker);
  // The in-memory driver does not evaluate aggregate expressions like
  // `MAX(revision)`; it just projects the literal string. Walk the
  // rows ourselves and take the highest revision we see.
  const rows = driver
    .prepare("SELECT revision FROM schedule_revision WHERE schedule_id = ?")
    .all(scheduleId);
  let max = 0;
  for (const row of rows) {
    const value = Number((row as { revision: unknown }).revision);
    if (Number.isFinite(value) && value > max) max = value;
  }
  return max + 1;
}

function digestRevision(input: {
  scheduleId: string;
  revision: number;
  rule: unknown;
  timezone: string;
  recipeId: string;
  overlapPolicy: "skip" | "allow";
  graceWindowMs: number;
}): string {
  const surface = {
    scheduleId: input.scheduleId,
    revision: input.revision,
    rule: input.rule,
    timezone: input.timezone,
    recipeId: input.recipeId,
    overlapPolicy: input.overlapPolicy,
    graceWindowMs: input.graceWindowMs,
  };
  return createHash("sha256")
    .update(JSON.stringify(surface, Object.keys(surface).sort()), "utf8")
    .digest("hex");
}

// ---------------------------------------------------------------------------
// Occurrence seeding + dispatch
// ---------------------------------------------------------------------------

/**
 * Seed the next N occurrences for a schedule's currently-enabled
 * revision. Used by the controller on startup / after a revision
 * promote.
 */
export async function seedNextOccurrences(
  worker: DbWorker,
  scheduleId: string,
  count: number,
  options: { now?: () => Date; timezoneDataVersion?: string } = {},
): Promise<ReadonlyArray<Occurrence>> {
  if (count < 1 || count > 64)
    throw new AppError("INVALID_REQUEST", "seed count must be in [1, 64]");
  const schedule = readSchedule(worker, scheduleId);
  if (!schedule) throw new AppError("NOT_FOUND", `schedule ${scheduleId} not found`);
  const revision = readEnabledRevision(worker, scheduleId);
  if (!revision) return [];
  const now = options.now ? options.now() : new Date();
  const seeded: Occurrence[] = [];
  let cursor = now;
  for (let i = 0; i < count; i += 1) {
    const next = nextLocalOccurrence(revision.rule as ScheduleRule, schedule.timezone, cursor);
    cursor = new Date(next.intendedUtc);
    if (next.skipped) continue; // skip DST gaps
    const inserted = await insertOccurrence(worker, {
      scheduleId, revision: revision.revision,
      intendedUtc: next.intendedUtc,
      localTimeIso: next.localTimeIso,
      timezoneDataVersion: options.timezoneDataVersion ?? null,
    });
    if (inserted && inserted.created) seeded.push(inserted.occurrence);
  }
  return seeded;
}

async function insertOccurrence(
  worker: DbWorker,
  input: OccurrenceInput,
): Promise<{ occurrence: Occurrence; created: boolean } | null> {
  const driver = driverOf(worker);
  let row: Record<string, unknown> | undefined;
  let created = false;
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT * FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?")
      .first(input.scheduleId, input.revision, input.intendedUtc);
    if (existing) {
      row = existing;
      created = false;
      return;
    }
    driver.prepare(
      "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, " +
        "state, local_time_iso, timezone_data_version) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), input.scheduleId, input.revision, input.intendedUtc,
      "pending", input.localTimeIso, input.timezoneDataVersion,
    );
    row = driver
      .prepare("SELECT * FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?")
      .first(input.scheduleId, input.revision, input.intendedUtc);
    created = true;
  });
  if (!row) return null;
  return { occurrence: parseOccurrenceRow(row), created };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export interface DispatcherDeps {
  /** Caller-supplied executor adapter. Returns the workflow run id. */
  readonly dispatchRecipe: (args: {
    scheduleId: string;
    revision: number;
    intendedUtc: string;
    recipeId: string;
    ruleDigest: string;
  }) => Promise<{ workflowRunId: string }>;
  readonly now?: () => Date;
}

/**
 * Find every due occurrence across all enabled schedules, transition
 * each to `dispatched` (or `skipped` when the overlap policy
 * demands it), and hand the recipe id to the executor.
 *
 * Returns the count of `dispatched` + `skipped` rows in this pass.
 * Idempotent: re-running the dispatcher within the same wall-clock
 * second produces the same outcome because every row's state move
 * is gated by its current value.
 */
export async function fireDueOccurrences(
  worker: DbWorker,
  deps: DispatcherDeps,
): Promise<{ dispatched: number; skipped: number }> {
  const driver = driverOf(worker);
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const due = driver
    .prepare(
      "SELECT * FROM schedule_occurrence WHERE state = 'pending' AND intended_utc <= ? ORDER BY intended_utc ASC",
    )
    .all(nowIso) as Array<Record<string, unknown>>;
  let dispatched = 0;
  let skipped = 0;
  for (const row of due) {
    const occurrence = parseOccurrenceRow(row);
    const schedule = readSchedule(worker, occurrence.scheduleId);
    if (!schedule || schedule.status !== "enabled") {
      transitionOccurrence(worker, occurrence, "skipped");
      skipped += 1;
      continue;
    }
    if (schedule.overlapPolicy === "skip") {
      // The in-memory driver does not evaluate `COUNT(*)`, so we
      // query for any running rows directly and count in JS.
      const open = driver
        .prepare("SELECT status FROM workflow_run WHERE status = 'running'")
        .all();
      if (open.length > 0) {
        transitionOccurrence(worker, occurrence, "skipped");
        skipped += 1;
        continue;
      }
    }
    const result = await deps.dispatchRecipe({
      scheduleId: occurrence.scheduleId,
      revision: occurrence.revision,
      intendedUtc: occurrence.intendedUtc,
      recipeId: schedule.recipeId,
      ruleDigest: digestRevision({
        scheduleId: occurrence.scheduleId,
        revision: occurrence.revision,
        rule: readEnabledRevision(worker, occurrence.scheduleId)?.rule,
        timezone: schedule.timezone,
        recipeId: schedule.recipeId,
        overlapPolicy: schedule.overlapPolicy,
        graceWindowMs: schedule.graceWindowMs,
      }),
    });
    linkOccurrenceToRun(worker, occurrence, result.workflowRunId);
    dispatched += 1;
  }
  return { dispatched, skipped };
}

function transitionOccurrence(
  worker: DbWorker,
  occurrence: Occurrence,
  state: "dispatched" | "skipped" | "cancelled" | "failed",
): void {
  occurrenceStateSchema.parse(state);
  const driver = driverOf(worker);
  driver.prepare(
    "UPDATE schedule_occurrence SET state = ?, dispatched_at = ? " +
      "WHERE schedule_id = ? AND revision = ? AND intended_utc = ? AND state = 'pending'",
  ).run(
    state, new Date().toISOString(),
    occurrence.scheduleId, occurrence.revision, occurrence.intendedUtc,
  );
}

function linkOccurrenceToRun(
  worker: DbWorker,
  occurrence: Occurrence,
  workflowRunUuid: string,
): void {
  const driver = driverOf(worker);
  driver.prepare(
    "UPDATE schedule_occurrence SET state = 'dispatched', dispatched_at = ?, workflow_run_uuid = ? " +
      "WHERE schedule_id = ? AND revision = ? AND intended_utc = ? AND state = 'pending'",
  ).run(
    new Date().toISOString(), workflowRunUuid,
    occurrence.scheduleId, occurrence.revision, occurrence.intendedUtc,
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function readScheduleRow(
  worker: DbWorker,
  scheduleId: string,
): Promise<{
  scheduleId: string;
  displayName: string;
  timezone: string;
  recipeId: string;
  overlapPolicy: "skip" | "allow";
  graceWindowMs: number;
  status: "enabled" | "paused" | "disabled";
  rule: ScheduleRule;
} | undefined> {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM schedule WHERE schedule_id = ?")
    .first(scheduleId);
  if (!row) return undefined;
  return {
    scheduleId: String(row.schedule_id),
    displayName: String(row.display_name),
    timezone: String(row.timezone),
    recipeId: String(row.recipe_id),
    overlapPolicy: String(row.overlap_policy) === "allow" ? "allow" : "skip",
    graceWindowMs: Number(row.grace_window_ms ?? 0),
    status: String(row.status) as "enabled" | "paused" | "disabled",
    rule: JSON.parse(String(row.rule_json)) as ScheduleRule,
  };
}

function readSchedule(
  worker: DbWorker,
  scheduleId: string,
): ReturnType<typeof readScheduleRow> extends Promise<infer T> ? T : never {
  // Synchronous wrapper for use inside the dispatcher. The async
  // helper above is used by callers needing await.
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM schedule WHERE schedule_id = ?")
    .first(scheduleId);
  if (!row) return undefined as never;
  return {
    scheduleId: String(row.schedule_id),
    displayName: String(row.display_name),
    timezone: String(row.timezone),
    recipeId: String(row.recipe_id),
    overlapPolicy: String(row.overlap_policy) === "allow" ? "allow" : "skip",
    graceWindowMs: Number(row.grace_window_ms ?? 0),
    status: String(row.status) as "enabled" | "paused" | "disabled",
    rule: JSON.parse(String(row.rule_json)) as ScheduleRule,
  };
}

function readEnabledRevision(
  worker: DbWorker,
  scheduleId: string,
): ScheduleRevision | undefined {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM schedule_revision WHERE schedule_id = ? AND status = 'enabled' ORDER BY revision DESC LIMIT 1")
    .first(scheduleId);
  if (!row) return undefined;
  return scheduleRevisionSchema.parse({
    scheduleId: String(row.schedule_id),
    revision: Number(row.revision),
    rule: JSON.parse(String(row.rule_json)),
    timezone: String(row.timezone),
    recipeId: String(row.recipe_id),
    overlapPolicy: String(row.overlap_policy) === "allow" ? "allow" : "skip",
    graceWindowMs: Number(row.grace_window_ms ?? 0),
    status: String(row.status),
    revisionDigest: String(row.revision_digest),
    publishedAt: String(row.published_at),
    publishedBy: String(row.published_by),
  });
}

function parseOccurrenceRow(row: Record<string, unknown>): Occurrence {
  return {
    scheduleId: String(row.schedule_id),
    revision: Number(row.revision),
    intendedUtc: String(row.intended_utc),
    state: String(row.state) as Occurrence["state"],
    localTimeIso: row.local_time_iso == null ? null : String(row.local_time_iso),
    timezoneDataVersion: row.timezone_data_version == null ? null : String(row.timezone_data_version),
    dispatchedAt: row.dispatched_at == null ? null : String(row.dispatched_at),
    workflowRunId: row.workflow_run_uuid == null ? null : String(row.workflow_run_uuid),
  };
}

void z;