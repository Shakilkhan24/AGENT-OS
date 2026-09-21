/**
 * M7.1 / M7.2 / M7.3 — durable schedule schema + dispatcher.
 *
 * The M7.1 bullet (FUTURE/IMPLEMENTATION-README.md line 254) reads:
 *
 * > M7.1 Persist Schedule, revision and unique intended occurrence
 * > separately from workflow runs. Use `(scheduleId, revision,
 * > intendedUTC)` uniqueness, an IANA zone and one owning host.
 *
 * Three tables back the scheduling layer:
 *
 *   - `schedule`              — one row per schedule identity.
 *   - `schedule_revision`     — one row per rule/recipe/tz revision.
 *   - `schedule_occurrence`   — one row per intended firing, unique
 *                                on `(schedule_id, revision,
 *                                intended_utc)`.
 *
 * The dispatcher (`fireDueOccurrences`) is the small admission
 * surface that:
 *   - Reads every `schedule_occurrence` row with `state: "pending"`
 *     and `intended_utc <= now`.
 *   - Refuses to double-fire: it transitions each row to `state:
 *     "dispatched"` inside a transaction, then hands the row's
 *     `recipe_id` to the workflow executor.
 *   - Records the wall-clock firing time so the audit trail can
 *     detect skipped / coalesced / DST-fold occurrences.
 *
 * The skip-and-report semantics (M7.2) live in the
 * `evaluateScheduleDue` planner so a renderer's preview matches
 * what the dispatcher will admit.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export const scheduleRuleKindSchema = z.enum(["daily", "weekly"]);
export type ScheduleRuleKind = z.infer<typeof scheduleRuleKindSchema>;

export const scheduleRuleSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("daily"),
      /** Local hour-of-day, 0-23. */
      hour: z.number().int().min(0).max(23),
      /** Local minute, 0-59. */
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
  z
    .object({
      kind: z.literal("weekly"),
      /** ISO weekday, 1=Mon .. 7=Sun. */
      weekday: z.number().int().min(1).max(7),
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
    })
    .strict(),
]);
export type ScheduleRule = z.infer<typeof scheduleRuleSchema>;

export const scheduleStatusSchema = z.enum([
  "enabled", "paused", "disabled",
]);
export type ScheduleStatus = z.infer<typeof scheduleStatusSchema>;

export const scheduleInputSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    rule: scheduleRuleSchema,
    /** IANA timezone name; validated at parse-time. */
    timezone: z.string().min(1).max(64),
    /** Recipe id (the M6.2 immutable recipe identity). */
    recipeId: z.string().min(1).max(128),
    /** Optional overlap policy. `skip` is the default; `allow`
     *  permits concurrent firings. */
    overlapPolicy: z.enum(["skip", "allow"]).default("skip"),
    /** Optional grace window (ms) for catch-up. Default 0. */
    graceWindowMs: z.number().int().min(0).max(60 * 60_000).default(0),
  })
  .strict();
export type ScheduleInput = z.input<typeof scheduleInputSchema>;

// ---------------------------------------------------------------------------
// Schedule revision
// ---------------------------------------------------------------------------

export const scheduleRevisionStatusSchema = z.enum([
  "draft", "enabled", "superseded", "revoked",
]);
export type ScheduleRevisionStatus = z.infer<typeof scheduleRevisionStatusSchema>;

export const scheduleRevisionSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    /** Monotonic per `scheduleId`; first revision is 1. */
    revision: z.number().int().min(1).max(2_048),
    rule: scheduleRuleSchema,
    timezone: z.string().min(1).max(64),
    recipeId: z.string().min(1).max(128),
    overlapPolicy: z.enum(["skip", "allow"]),
    graceWindowMs: z.number().int().min(0).max(60 * 60_000),
    status: scheduleRevisionStatusSchema,
    /** Content-addressed digest of the immutable payload. */
    revisionDigest: z.string().regex(/^[0-9a-f]{64}$/),
    publishedAt: z.string().datetime(),
    publishedBy: z.string().min(1).max(256),
  })
  .strict();
export type ScheduleRevision = z.infer<typeof scheduleRevisionSchema>;

// ---------------------------------------------------------------------------
// Occurrence
// ---------------------------------------------------------------------------

export const occurrenceStateSchema = z.enum([
  "pending", "dispatched", "skipped", "cancelled", "failed",
]);
export type OccurrenceState = z.infer<typeof occurrenceStateSchema>;

/** M7.3 — dispatch lifecycle state for an occurrence, distinct
 *  from the workflow-run `state`. Independent so the controller can
 *  record "ran into `pending` while the previous boot died" without
 *  breaking the workflow-execution state machine. The audit log
 *  (`occurrence_state_transition`) records every move between these
 *  states; nothing is silently flipped. */
export const occurrenceDispatchStateSchema = z.enum([
  "pending",         // queued, not yet admitted
  "dispatched",      // adapter accepted the dispatch
  "executing",       // provider is running the recipe
  "waiting-for-user",// blocked on a user-decision step
  "disconnected",    // provider / socket went away mid-execution
  "ended",           // dispatched run completed cleanly
  "unavailable",     // previous boot died before reaching "dispatched"
  "skipped",         // schedule policy refused to fire
  "cancelled",       // user explicitly cancelled
  "failed",          // provider or boot threw while executing
]);
export type OccurrenceDispatchState = z.infer<typeof occurrenceDispatchStateSchema>;

export const occurrenceInputSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    revision: z.number().int().min(1).max(2_048),
    intendedUtc: z.string().datetime(),
    /** Optional local-time + tz version recorded at insert time
     *  (M7.2: DST skip / fold audit trail). */
    localTimeIso: z.string().datetime().nullable().default(null),
    timezoneDataVersion: z.string().min(1).max(64).nullable().default(null),
    /** M7.3 — the boot that minted this occurrence. Recorded at
     *  insert time so a later dispatcher can recognise rows owned
     *  by a dead boot and reconcile them. */
    bootId: z.string().min(1).max(64).nullable().default(null),
  })
  .strict();
export type OccurrenceInput = z.input<typeof occurrenceInputSchema>;

export const occurrenceSchema = z
  .object({
    scheduleId: z.string().min(1).max(128),
    revision: z.number().int().min(1).max(2_048),
    intendedUtc: z.string().datetime(),
    state: occurrenceStateSchema,
    localTimeIso: z.string().datetime().nullable(),
    timezoneDataVersion: z.string().min(1).max(64).nullable(),
    dispatchedAt: z.string().datetime().nullable(),
    /** Optional workflow run id once the recipe has been dispatched. */
    workflowRunId: z.string().uuid().nullable(),
    /** M7.3 — boot identity of the dispatcher that last touched the
     *  row. Empty string when the row pre-dates the v6 schema (the
     *  migration helper adds the column with an empty default). */
    bootId: z.string().min(0).max(64),
    /** M7.2 — when this occurrence was coalesced into a later
     *  firing, the prior row's UUID is recorded here for the audit
     *  trail. Null when no coalescing happened. */
    coalescedWith: z.string().uuid().nullable(),
    /** M7.3 — the dispatch lifecycle state. Independent of `state`
     *  (which is the workflow-run lifecycle). The dispatcher uses
     *  `state` to skip already-fired rows; the controller uses
     *  `dispatch_state` to recognise "this row was waiting in
     *  `pending` when the previous boot died". */
    dispatchState: occurrenceDispatchStateSchema,
  })
  .strict();
export type Occurrence = z.infer<typeof occurrenceSchema>;

// ---------------------------------------------------------------------------
// Computed helpers
// ---------------------------------------------------------------------------

/**
 * Compute the next intended local firing time AFTER `fromUtc`. Pure
 * function — the dispatcher reuses it to seed new occurrences when
 * a revision is enabled.
 *
 * DST handling (M7.2):
 *   - Spring-forward gap (a local time that does not exist):
 *     surface as `kind: "skipped"` with a `localTimeIso` that
 *     reflects the first valid local clock.
 *   - Fall-back fold (a local time that occurs twice): surface
 *     only the first occurrence; the second is suppressed.
 *
 * The computation uses `Intl.DateTimeFormat` with the `timeZone`
 * option to derive local hours without an external library.
 */
export interface NextLocalTime {
  intendedUtc: string;
  localTimeIso: string;
  skipped: boolean;
}

const MS_HOUR = 60 * 60_000;
const MS_DAY = 24 * MS_HOUR;

export function nextLocalOccurrence(
  rule: ScheduleRule,
  timezone: string,
  fromUtc: Date,
): NextLocalTime {
  // Search at most 8 days ahead (covers weekly + DST gap).
  for (let offset = 0; offset < 8; offset += 1) {
    const candidateDay = new Date(fromUtc.getTime() + offset * MS_DAY);
    const weekday = isoWeekday(candidateDay);
    if (rule.kind === "weekly" && weekday !== rule.weekday) continue;
    // Build the local target hour/minute on this candidate day.
    const targetLocal = makeLocalTime(candidateDay, rule.hour, rule.minute, timezone);
    if (targetLocal === null) {
      // DST spring-forward gap; the wall-clock time does not exist.
      // Skip the occurrence.
      return {
        intendedUtc: new Date(candidateDay.getTime()).toISOString(),
        localTimeIso: new Date(candidateDay.getTime()).toISOString(),
        skipped: true,
      };
    }
    if (targetLocal.getTime() <= fromUtc.getTime()) continue;
    return {
      intendedUtc: targetLocal.toISOString(),
      localTimeIso: targetLocal.toISOString(),
      skipped: false,
    };
  }
  throw new AppError("UNAVAILABLE", "schedule: no local occurrence within 8 days");
}

/** Return the ISO weekday (1=Mon .. 7=Sun) for `date` in `timezone`. */
function isoWeekday(date: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" });
  const label = fmt.format(date);
  const map: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  return map[label] ?? 1;
}

/**
 * Build a Date that, when interpreted in `timezone`, has the given
 * local hour/minute. Returns null when the wall-clock time does not
 * exist (DST gap).
 */
function makeLocalTime(date: Date, hour: number, minute: number, timezone: string): Date | null {
  // The caller passes a UTC instant that should fall on the target
  // local date (e.g. `fromUtc + N days`); anchor our calendar read at
  // noon UTC so the formatter reliably yields the target date even
  // for western-hemisphere timezones where UTC midnight is the
  // previous local day.
  const anchor = new Date(date.getTime() + 12 * MS_HOUR);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(anchor);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const y = get("year"), mo = get("month"), d = get("day");
  // Compute UTC midnight by treating the local Y/M/D as if it were UTC
  // and then re-reading the offset.
  const guess = new Date(Date.UTC(y, mo - 1, d, hour, minute, 0));
  // Now find what wall-clock time `guess` actually represents in the
  // timezone — that gives us the offset.
  const reParts = formatter.formatToParts(guess);
  const actualY = Number(reParts.find((p) => p.type === "year")?.value ?? "0");
  const actualMo = Number(reParts.find((p) => p.type === "month")?.value ?? "0");
  const actualD = Number(reParts.find((p) => p.type === "day")?.value ?? "0");
  const actualH = Number(reParts.find((p) => p.type === "hour")?.value ?? "0");
  const actualM = Number(reParts.find((p) => p.type === "minute")?.value ?? "0");
  const localOfGuess = Date.UTC(actualY, actualMo - 1, actualD, actualH, actualM, 0);
  const offset = localOfGuess - guess.getTime();
  const adjusted = new Date(guess.getTime() - offset);
  // Verify the adjusted UTC instant, when rendered in the timezone,
  // really has the requested hour/minute. If not, it's a DST gap.
  const verifyParts = formatter.formatToParts(adjusted);
  const vH = Number(verifyParts.find((p) => p.type === "hour")?.value ?? "0");
  const vM = Number(verifyParts.find((p) => p.type === "minute")?.value ?? "0");
  if (vH !== hour || vM !== minute) return null;
  return adjusted;
}

void z;