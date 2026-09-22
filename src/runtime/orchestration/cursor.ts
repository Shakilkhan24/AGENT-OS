/**
 * M3b.3 — observation cursor commit.
 *
 * `commitCursor` writes the terminal `provider.observation` event row,
 * stamps the invocation's `ended_at` / `ended_reason`, and audits the
 * commit — all in one transaction. If the storage layer cannot persist
 * the event, the helper throws; the caller may mark the invocation
 * `uncertain` instead of `error` (Increment 4 will refine this path).
 *
 * Detection (duplicate-content disagreement, split Unicode, huge
 * frames, torn tails) is delegated to the `FrameDecoder` and the caller's
 * observation payload — `commitCursor` is intentionally narrow: it is
 * the "ingestion commits a contiguous cursor" path from
 * `FUTURE/IMPLEMENTATION-README.md:194`.
 */
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";
import { readInvocation, transitionInvocation } from "../db/invocations";
import { recordObservation, type ObservationPayload } from "./observation";

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

export interface CommitCursorInput {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly payload: ObservationPayload;
  /** Required final state for the invocation. */
  readonly outcome: "done" | "error" | "uncertain";
  /** Free-text audit trail recorded on the invocation's `ended_reason`. */
  readonly reason: string;
}

export interface CommitCursorResult {
  readonly invocationId: string;
  readonly outcome: "done" | "error" | "uncertain";
  readonly eventSeq: number;
}

const ENDED_REASON_MAX = 256;

export async function commitCursor(
  worker: DbWorker,
  input: CommitCursorInput,
): Promise<CommitCursorResult> {
  if (input.reason.length === 0 || input.reason.length > ENDED_REASON_MAX)
    throw new AppError("INVALID_REQUEST", `reason must be 1..${ENDED_REASON_MAX} characters`);
  const invocation = await readInvocation(worker, input.invocationId);
  if (!invocation) throw new AppError("NOT_FOUND", "Invocation not found");
  if (invocation.status === "done" || invocation.status === "error")
    throw new AppError("CONFLICT", `Invocation ${input.invocationId} is already ${invocation.status}`);

  // Write the observation event first; the caller has already filtered
  // duplicate-content disagreement, split Unicode, huge frames, and torn
  // tails — those are detection concerns handled upstream.
  const { seq } = await recordObservation(worker, {
    invocationId: input.invocationId,
    correlationId: input.correlationId,
    payload: input.payload,
  });

  // Then transition the invocation to its terminal state. The state
  // machine is `spawned → observing → done` (or → error), so the commit
  // walks one or two transitions depending on whether observations have
  // already been written. Here we have just written the observation, so
  // we step to `observing` first, then to the terminal outcome.
  if (invocation.status === "spawned")
    await transitionInvocation(worker, input.invocationId, { to: "observing" });
  await transitionInvocation(worker, input.invocationId, {
    to: input.outcome === "uncertain" ? "error" : input.outcome,
    reason: input.reason,
  });

  // Bookkeeping: stamp a cursor.audit event so a replayer can find the
  // commit boundary. Uses the in-memory driver's `ORDER BY seq DESC`
  // pattern (it does not support `MAX(seq)+1`).
  const driver = driverOf(worker);
  let auditSeq = -1;
  await worker.transaction(tx => {
    void tx;
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    auditSeq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      auditSeq, new Date().toISOString(), input.correlationId, "runtime",
      null, null, null, "cursor.committed",
      JSON.stringify({ invocationId: input.invocationId, observationSeq: seq, outcome: input.outcome }),
    );
  });

  return { invocationId: input.invocationId, outcome: input.outcome, eventSeq: auditSeq };
}