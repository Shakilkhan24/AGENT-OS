/**
 * M7 — in-runtime scheduler loop.
 *
 * M7.3 (FUTURE/IMPLEMENTATION-README.md line 256):
 *
 *   "Timers only wake durable admission. Persist wait/deadline
 *    decisions. Monotonic elapsed time within a boot; record wall
 *    time + boot identity across restart. Separate queued/executing/
 *    waiting-for-user/disconnected intervals. Unavailable time stays
 *    uncertain. Pausing a schedule prevents future starts; does not
 *    stop an active workflow."
 *
 * The scheduler is the small admission loop that wakes on a
 * `setTimeout` (armed from the next-due occurrence's `intended_utc`)
 * and calls `fireDueOccurrences`. It is the ONLY path that calls
 * `transitionOccurrenceDispatchState` directly; per-row moves go
 * through the occurrence-state module.
 *
 * Boot-boundary reconciliation (user-confirmed decision: "mark
 * `unavailable` and continue"):
 *
 *   - On `start()`, scan every `schedule_occurrence` row whose
 *     `dispatch_state = "pending"` and `boot_id !== currentBootId`.
 *   - Each such row is transitioned to `dispatch_state = "unavailable"`
 *     with `reason: "boot_boundary_crossed"`. The row is NOT deleted;
 *     a renderer / audit reader can show "this firing was stranded by
 *     a prior boot". The schedule continues forward from `now` via the
 *     normal `seedNextOccurrences` reseed.
 *   - The same scan also catches `dispatch_state = "dispatched"` rows
 *     stranded mid-execution by the prior boot and reconciles them
 *     to `unavailable` (the workflow executor will eventually move them
 *     to `ended | failed` through its own seam; the scheduler does
 *     not race that path).
 *
 * Timer contract (M7.3: "timers only wake durable admission"):
 *
 *   - `armNextTick()` finds `MIN(intended_utc)` of all pending rows
 *     and calls `setTimeout(remaining, tick)`. The timer is the
 *     WAKEUP, not the admission — the row's `state` move is still
 *     gated by `intended_utc <= now` inside `fireDueOccurrences`, so
 *     a delayed timer cannot double-fire.
 *   - `setTimeout` is `.unref()`'d so a sleeping scheduler does not
 *     keep Node alive.
 *
 * Errors during `tick` are caught + logged (best-effort) and the
 * loop rearms with a 5 s backoff so a transient driver failure
 * (e.g. mid-commit) does not stall the whole runtime.
 */
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";
import {
  fireDueOccurrences,
  seedNextOccurrences,
  type DispatcherDeps,
} from "./schedule-dispatcher";
import { transitionOccurrenceDispatchState } from "./occurrence-state";
import type { BootIdentity } from "../db/boot-identity";

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

export interface SchedulerDeps extends DispatcherDeps {
  /** The runtime's boot identity; rows owned by other boots get
   *  reconciled to `unavailable` on `start()`. */
  readonly bootIdentity: BootIdentity;
  /** Maximum future occurrences to keep per schedule. Default 10. */
  readonly lookAheadCount?: number;
  /** Minimum timer rearm interval (ms). Default 5 000. */
  readonly tickLookaheadMs?: number;
  /** Optional clock seam (testing). */
  readonly now?: () => Date;
}

/** M7.3 — return the count of rows reconciled + the smallest
 *  `intended_utc` for the next-due pending row (or `null` when no
 *  due rows exist). */
export interface SchedulerTickResult {
  readonly dispatched: number;
  readonly skipped: number;
  readonly coalesced: number;
  readonly unavailable: number;
  readonly seeded: number;
  readonly nextIntendedUtc: string | null;
}

interface ScheduleRow {
  schedule_id: string;
  status: string;
}

interface PendingRow {
  schedule_id: string;
  revision: number;
  intended_utc: string;
  dispatch_state: string;
  boot_id: string;
}

/**
 * The scheduler loop. One instance per workspace; constructed after
 * `mintBootIdentity` so it knows which rows to claim.
 */
export class Scheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running = false;
  private closed = false;
  private currentBootId: string;
  private currentTick: Promise<SchedulerTickResult | undefined> | undefined;
  constructor(private readonly worker: DbWorker, private readonly deps: SchedulerDeps) {
    this.currentBootId = deps.bootIdentity.bootId;
  }

  /** Boot the loop. Idempotent: re-calling `start` while running is
   *  a no-op. Returns once reconciliation + reseed have completed so
   *  the caller can log "scheduler armed" without an async race. */
  async start(): Promise<SchedulerTickResult> {
    if (this.closed) throw new AppError("UNAVAILABLE", "scheduler: already closed");
    if (this.running) return { dispatched: 0, skipped: 0, coalesced: 0, unavailable: 0, seeded: 0, nextIntendedUtc: null };
    this.running = true;
    try {
      const reconcile = await this.reconcileAcrossBootBoundary();
      const seeded = await this.reseedAll();
      this.arm();
      return { ...reconcile, seeded };
    } catch (error) {
      this.running = false;
      throw error;
    }
  }

  /** Stop the loop. Cancels the pending timer. Idempotent. */
  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // Wait for the in-flight tick to finish so the close is ordered.
    if (this.currentTick) await this.currentTick.catch(() => {});
    this.running = false;
  }

  /** Manually trigger a tick (e.g. after a schedule revision promote).
   *  Returns the result of `fireDueOccurrences` plus the next-due
   *  timestamp. Re-arms the timer. */
  async tick(): Promise<SchedulerTickResult> {
    if (this.closed) throw new AppError("UNAVAILABLE", "scheduler: already closed");
    return this.runTick();
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Walk every `pending` (and stranded `dispatched`) row whose
   *  `boot_id` doesn't match the current boot and reconcile its
   *  `dispatch_state` to `"unavailable"`. The row stays so the audit
   *  trail can answer "this firing was orphaned". */
  private async reconcileAcrossBootBoundary(): Promise<SchedulerTickResult> {
    const driver = driverOf(this.worker);
    // The in-memory driver does not evaluate `WHERE boot_id <> ?`
    // with a parameter binding reliably (predicate support varies);
    // fetch every pending row and filter in JS.
    const all = driver.prepare(
      "SELECT schedule_id, revision, intended_utc, dispatch_state, boot_id FROM schedule_occurrence " +
        "WHERE dispatch_state = 'pending' OR dispatch_state = 'dispatched'",
    ).all() as unknown as Array<PendingRow>;
    let unavailable = 0;
    for (const row of all) {
      if (row.boot_id === this.currentBootId) continue;
      try {
        await transitionOccurrenceDispatchState(this.worker, {
          scheduleId: row.schedule_id,
          revision: row.revision,
          intendedUtc: row.intended_utc,
        }, "unavailable", {
          reason: "boot_boundary_crossed",
          recordedBy: `scheduler:${this.currentBootId}`,
        });
        unavailable += 1;
      } catch (error) {
        // AppError("CONFLICT") means the row already moved on
        // (e.g. raced with a manual cancel); skip + carry on.
        if (error instanceof AppError && error.failure.code === "CONFLICT") continue;
        throw error;
      }
    }
    return { dispatched: 0, skipped: 0, coalesced: 0, unavailable, seeded: 0, nextIntendedUtc: null };
  }

  /** Seed the next batch of occurrences for every enabled schedule so
   *  the dispatcher always has ≥ lookAheadCount future rows ready. */
  private async reseedAll(): Promise<number> {
    const driver = driverOf(this.worker);
    const lookAhead = this.deps.lookAheadCount ?? 10;
    const tzVersion = typeof process.versions.icu === "string" && process.versions.icu.length > 0
      ? `icu:${process.versions.icu}`
      : "unknown";
    const schedules = driver.prepare(
      "SELECT schedule_id, status FROM schedule WHERE status = 'enabled'",
    ).all() as unknown as Array<ScheduleRow>;
    let total = 0;
    for (const schedule of schedules) {
      const seeded = await seedNextOccurrences(this.worker, schedule.schedule_id, lookAhead, {
        bootId: this.currentBootId,
        timezoneDataVersion: tzVersion,
      });
      total += seeded.length;
    }
    return total;
  }

  /** Compute the next-due intended_utc across all pending rows, or
   *  `null` if none. Returns the delay (ms) until that instant; the
   *  caller clamps the delay to `tickLookaheadMs`. */
  private nextPendingDelay(): { intendedUtc: string | null; delayMs: number } {
    const driver = driverOf(this.worker);
    const row = driver.prepare(
      "SELECT intended_utc FROM schedule_occurrence " +
        "WHERE state = 'pending' AND dispatch_state IN ('pending', 'dispatched', 'executing') " +
        "ORDER BY intended_utc ASC LIMIT 1",
    ).first() as { intended_utc?: string } | undefined;
    if (!row || !row.intended_utc) return { intendedUtc: null, delayMs: this.deps.tickLookaheadMs ?? 5_000 };
    const now = (this.deps.now ?? (() => new Date()))();
    const intendedMs = new Date(row.intended_utc).getTime();
    const delay = Math.max(0, intendedMs - now.getTime());
    return { intendedUtc: row.intended_utc, delayMs: delay };
  }

  /** Arm the wakeup timer. Clamped to `tickLookaheadMs`. The timer
   *  is `.unref()`'d so it does not keep the Node process alive. */
  private arm(): void {
    if (this.closed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    const lookahead = this.deps.tickLookaheadMs ?? 5_000;
    const { delayMs } = this.nextPendingDelay();
    const wait = Math.min(Math.max(delayMs, 0), lookahead);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.currentTick = this.runTick()
        .then((result) => { this.arm(); return result; })
        .catch((error: unknown) => {
          // Best-effort: log + rearm with the minimum lookahead so a
          // transient driver failure does not stall the whole loop.
          console.error("scheduler: tick failed", error);
          this.arm();
          return undefined;
        });
    }, wait);
    // Don't keep Node alive when the scheduler is the only thing waiting.
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Run one tick: fire due occurrences, reseed, then return the
   *  full result. Errors propagate so callers (tests + IPC handlers)
   *  can react. The arming happens in `arm()` (called by the timer). */
  private async runTick(): Promise<SchedulerTickResult> {
    const driver = driverOf(this.worker);
    const fireResult = await fireDueOccurrences(this.worker, this.deps);
    const seeded = await this.reseedAll();
    const next = this.nextPendingDelay();
    void driver; // touch driver so the binding isn't dead-code-eliminated
    return {
      dispatched: fireResult.dispatched,
      skipped: fireResult.skipped,
      coalesced: fireResult.coalesced,
      unavailable: 0,
      seeded,
      nextIntendedUtc: next.intendedUtc,
    };
  }
}

void AppError;
