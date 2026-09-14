/**
 * M3b.3 — stop policy.
 *
 * `requestStop` is the runtime's per-run cancellation hook. It:
 *  - sets the run's status to `cancelled` (preserving audit),
 *  - records a `stop.requested` audit event,
 *  - blocks subsequent `executeOnce` calls for the run by flipping a
 *    process-global stop flag (cleared by `resetStop` for tests).
 *
 * Unobserved descendants remain in `pending` until the orchestrator
 * reports them as `unconfirmed` in the run summary; cross-run
 * cancellation propagation is M3c scope (see
 * `FUTURE/IMPLEMENTATION-README.md:193`).
 *
 * The policy is deliberately simple — Increment 4 will replace the
 * process-global with a per-run SQLite row so a restart preserves the
 * stop intent across reclaim.
 */
import { z } from "zod";
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";
import { readRun, transitionRun } from "../db/runs";

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

const STOP_INPUT = z.object({
  runId: z.string().uuid(),
  reason: z.string().min(1).max(256),
  requestedBy: z.string().min(1).max(256),
}).strict();
export type RequestStopInput = z.input<typeof STOP_INPUT>;

export interface RequestStopResult {
  readonly runId: string;
  readonly status: "cancelled";
  readonly blockedExecuteOnce: true;
  readonly eventSeq: number;
}

/** Process-global stops keyed by runId. Cleared by `resetStop` (tests). */
const stoppedRuns = new Set<string>();

/** Test seam: query whether a run is stopped. */
export function isStopped(runId: string): boolean {
  return stoppedRuns.has(runId);
}

/** Test seam: clear a single run's stop flag. */
export function clearStop(runId: string): void {
  stoppedRuns.delete(runId);
}

/** Test seam: clear ALL stop flags. */
export function resetStops(): void {
  stoppedRuns.clear();
}

export async function requestStop(
  worker: DbWorker,
  input: RequestStopInput,
): Promise<RequestStopResult> {
  const parsed = STOP_INPUT.parse(input);
  const run = await readRun(worker, parsed.runId);
  if (!run) throw new AppError("NOT_FOUND", "Run not found");
  // Already-cancelled runs are idempotent.
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed") {
    return { runId: parsed.runId, status: "cancelled", blockedExecuteOnce: true, eventSeq: -1 };
  }
  await transitionRun(worker, parsed.runId, "cancelled");
  stoppedRuns.add(parsed.runId);
  const driver = driverOf(worker);
  let eventSeq = -1;
  await worker.transaction(tx => {
    void tx;
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    eventSeq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      eventSeq, new Date().toISOString(), parsed.runId, "runtime",
      null, null, null, "stop.requested",
      JSON.stringify({ runId: parsed.runId, reason: parsed.reason, requestedBy: parsed.requestedBy }),
    );
  });
  return { runId: parsed.runId, status: "cancelled", blockedExecuteOnce: true, eventSeq };
}