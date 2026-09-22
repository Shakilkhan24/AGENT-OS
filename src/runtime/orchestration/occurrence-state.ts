/**
 * M7.3 — occurrence dispatch state machine.
 *
 * Every move on `schedule_occurrence.dispatch_state` is gated by a
 * transition table and recorded in `occurrence_state_transition`
 * inside the same transaction that flips the row's `dispatch_state`.
 * The audit row carries both wall-clock ISO timestamp AND the
 * monotonic-ms-since-boot basis so audit readers can answer "was
 * this move made by the same process that originally dispatched it".
 *
 * State diagram (M7.3 spec):
 *
 *   pending ──► dispatched ──► executing ──► waiting-for-user
 *      │            │              │              │
 *      │            │              └──────► disconnected
 *      │            │                             │
 *      │            ▼                             ▼
 *      │         ended ────────────────────► (terminal)
 *      ▼
 *   unavailable (terminal; prior boot died)
 *   skipped (terminal; schedule policy refused)
 *   cancelled (terminal; user-initiated)
 *   failed (terminal; provider or boot threw)
 *
 * Invariants:
 *   - `assertTransition(from, to)` throws `AppError("CONFLICT")` on
 *     any move not listed below. The dispatcher must catch + surface
 *     the rejection rather than letting a row silently land in a
 *     state the next controller cannot recognise.
 *   - `transitionOccurrenceDispatchState` is the only path that
 *     touches `dispatch_state`. It writes the row, inserts the
 *     audit entry, and commits both inside one transaction so a
 *     crash before commit leaves the row in its previous state.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "../db/worker";
import {
  occurrenceDispatchStateSchema,
  type OccurrenceDispatchState,
} from "../db/schedule-schema";
import { monotonicNow, markBootBasis, readBootBasis } from "../db/monotonic";

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

/** Allowed transitions. The set is intentionally narrow — every
 *  move not listed here is rejected as `CONFLICT`. */
const ALLOWED_TRANSITIONS: Readonly<Record<OccurrenceDispatchState, ReadonlyArray<OccurrenceDispatchState>>> = {
  pending: ["dispatched", "skipped", "cancelled", "unavailable"],
  dispatched: ["executing", "ended", "disconnected", "failed", "cancelled"],
  executing: ["waiting-for-user", "ended", "disconnected", "failed"],
  "waiting-for-user": ["executing", "ended", "disconnected", "failed", "cancelled"],
  disconnected: ["executing", "failed", "ended", "cancelled"],
  ended: [],          // terminal
  unavailable: [],    // terminal
  skipped: [],        // terminal
  cancelled: [],      // terminal
  failed: [],         // terminal
};

/** Throws `AppError("CONFLICT")` when the move is not in
 *  `ALLOWED_TRANSITIONS`. */
export function assertTransition(
  from: OccurrenceDispatchState,
  to: OccurrenceDispatchState,
): void {
  occurrenceDispatchStateSchema.parse(from);
  occurrenceDispatchStateSchema.parse(to);
  const next = ALLOWED_TRANSITIONS[from];
  if (!next.includes(to)) {
    throw new AppError("CONFLICT",
      `occurrence dispatch_state cannot move from ${from} to ${to}`,
      { sourceId: "occurrence-state" });
  }
}

/** Throws `AppError("CONFLICT")` when the move is not in
 *  `ALLOWED_TRANSITIONS`. Same as {@link assertTransition} but
 *  parses inputs through Zod (so callers can pass untrusted raw
 *  values). */
export function assertTransitionRaw(from: unknown, to: unknown): void {
  assertTransition(
    occurrenceDispatchStateSchema.parse(from),
    occurrenceDispatchStateSchema.parse(to),
  );
}

interface OccurrenceKey {
  scheduleId: string;
  revision: number;
  intendedUtc: string;
}

export interface TransitionOptions {
  /** Why the move happened — surfaces in the audit row's `reason`. */
  readonly reason?: string;
  /** Identity recorded in the audit row's `recorded_by` (e.g.
   *  `workspace.bootIdentity.bootId` or a renderer-side user id). */
  readonly recordedBy?: string;
  /** Override the monotonic clock (test seam). Defaults to the
   *  module's monotonic clock anchored at `markBootBasis`. */
  readonly monotonicNow?: () => bigint;
  /** Override the wall clock (test seam). Defaults to `Date.now`. */
  readonly nowIso?: () => string;
}

/**
 * Transition a single occurrence row's `dispatch_state` and insert
 * an audit row inside one transaction. The audit row carries:
 *
 *   - `from_state`, `to_state` — the move being recorded.
 *   - `monotonic_ms_since_boot` — read from the boot basis if it
 *     has been marked, else `0n` (i.e. "first action of this
 *     boot"). The audit reader can subtract the boot's basis to
 *     compare against other audits made in the same boot.
 *   - `wall_clock_iso` — `Date.toISOString()`.
 *   - `reason`, `recorded_by` — caller-supplied.
 *
 * Returns the audit row's UUID so callers can reference it (e.g.
 * `coalesced_with`).
 */
export async function transitionOccurrenceDispatchState(
  worker: DbWorker,
  key: OccurrenceKey,
  to: OccurrenceDispatchState,
  options: TransitionOptions = {},
): Promise<{ auditUuid: string; fromState: OccurrenceDispatchState; toState: OccurrenceDispatchState }> {
  occurrenceDispatchStateSchema.parse(to);
  const driver = driverOf(worker);
  const monotonicFn = options.monotonicNow ?? monotonicNow;
  const nowFn = options.nowIso ?? (() => new Date().toISOString());
  let fromState: OccurrenceDispatchState | undefined;
  let auditUuid: string | undefined;
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT dispatch_state FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?")
      .first(key.scheduleId, key.revision, key.intendedUtc) as { dispatch_state?: string } | undefined;
    if (!existing) {
      throw new AppError("NOT_FOUND",
        `occurrence ${key.scheduleId}#${key.revision}@${key.intendedUtc} not found`);
    }
    fromState = occurrenceDispatchStateSchema.parse(existing.dispatch_state);
    assertTransition(fromState, to);
    driver.prepare(
      "UPDATE schedule_occurrence SET dispatch_state = ? " +
        "WHERE schedule_id = ? AND revision = ? AND intended_utc = ?",
    ).run(to, key.scheduleId, key.revision, key.intendedUtc);
    auditUuid = randomUUID();
    const basis = readBootBasis() ?? 0n;
    const elapsed = basis === 0n ? 0n : (monotonicFn() - basis);
    driver.prepare(
      "INSERT INTO occurrence_state_transition " +
        "(uuid, occurrence_uuid, from_state, to_state, monotonic_ms_since_boot, wall_clock_iso, reason, recorded_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      auditUuid,
      key.scheduleId + ":" + key.revision + ":" + key.intendedUtc,
      fromState,
      to,
      elapsed.toString(10),
      nowFn(),
      options.reason ?? "",
      options.recordedBy ?? "",
    );
  });
  if (auditUuid === undefined || fromState === undefined) {
    throw new AppError("UNAVAILABLE", "transition did not commit (audit row missing)");
  }
  return { auditUuid, fromState, toState: to };
}

/** Mark the current process's monotonic boot basis so subsequent
 *  transitions record their elapsed-since-boot. Idempotent — first
 *  call wins (subsequent calls do not reset the basis, because the
 *  audit reader assumes a single basis per boot). */
export function markBootBasisForState(): bigint {
  return markBootBasis();
}

void z;
