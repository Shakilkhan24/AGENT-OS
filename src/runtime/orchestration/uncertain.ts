/**
 * M3b.2 — ambiguous dispatch tombstone.
 *
 * `markAmbiguous` is the runtime's only path for "we tried to spawn the
 * provider, the handle died before first ack, and we cannot know what
 * external effects happened". The decision rule lives in D-4:
 *
 *  - An ambiguous dispatch is **terminal**. The invocation is transitioned
 *    to `error` with `ended_reason = "ambiguous-dispatch"`.
 *  - **Never respawned.** A second executeOnce for the same
 *    `(runId, idempotencyKey)` re-hits the existing `error` invocation;
 *    the orchestrator surfaces the ambiguity to the caller.
 *  - A `dispatch.ambiguous` audit event is written so the run timeline
 *    carries the explanation.
 *
 * This module is intentionally tiny — the only state machine transitions
 * it performs are `observing → error` (or `spawned → error`, depending on
 * how far the dispatch got) plus the audit event.
 */
import { randomUUID } from "node:crypto";
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";
import { readInvocation, transitionInvocation } from "../db/invocations";

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

export interface MarkAmbiguousInput {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly reason: string;
}

export interface MarkAmbiguousResult {
  readonly invocationId: string;
  readonly outcome: "error";
  /** Always `ambiguous-dispatch` — the canonical tombstone for an unacked dispatch. */
  readonly endedReason: "ambiguous-dispatch";
  readonly detail: string;
  readonly eventSeq: number;
}

const REASON_MAX = 256;

export async function markAmbiguous(
  worker: DbWorker,
  input: MarkAmbiguousInput,
): Promise<MarkAmbiguousResult> {
  if (input.reason.length === 0 || input.reason.length > REASON_MAX)
    throw new AppError("INVALID_REQUEST", `reason must be 1..${REASON_MAX} characters`);
  const invocation = await readInvocation(worker, input.invocationId);
  if (!invocation) throw new AppError("NOT_FOUND", "Invocation not found");
  // Already terminal? Don't rewrite; surface the existing state so the
  // caller can tell whether they raced a previous mark.
  if (invocation.status === "error" || invocation.status === "done")
    return { invocationId: input.invocationId, outcome: "error", endedReason: "ambiguous-dispatch", detail: input.reason, eventSeq: -1 };
  await transitionInvocation(worker, input.invocationId, { to: "error", reason: "ambiguous-dispatch" });
  const driver = driverOf(worker);
  let eventSeq = -1;
  await worker.transaction(tx => {
    void tx;
    // The in-memory driver doesn't support `SELECT MAX(seq)+1`. Order by
    // seq descending and compute the next monotonic value.
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    eventSeq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      eventSeq, new Date().toISOString(), input.correlationId, "runtime",
      null, null, null, "dispatch.ambiguous",
      JSON.stringify({ invocationId: input.invocationId, reason: input.reason }),
    );
  });
  void randomUUID;
  return { invocationId: input.invocationId, outcome: "error", endedReason: "ambiguous-dispatch", detail: input.reason, eventSeq };
}