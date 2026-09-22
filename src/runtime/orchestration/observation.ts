/**
 * M3b.2 — durable observation log.
 *
 * `recordObservation` writes one `event` row of type `provider.observation`
 * with the supplied payload. The cursor commit (Increment 3) wraps this
 * call in the same transaction as the invocation's `ended_at` /
 * `ended_reason` write so a power-cut between the two leaves the system
 * consistent.
 *
 * The payload is the raw observation: `{ startup, exit, usage? }` where
 * `startup` and `exit` are non-nullable (the orchestrator never records
 * a half-observation) and `usage` is nullable because providers that
 * don't expose token counts simply omit the field.
 *
 * M7.5 extends `observationUsageSchema` with `costUsd` + the pinned
 * `pricingTierDigest` so a renderer can display reported spend
 * separated from estimates and with explicit "freshness". The
 * defaults are `null` so existing observation rows parse unchanged.
 *
 * Mirrors the transactional next-seq insert at `src/runtime/db/reconcile.ts:90-101`.
 */
import { z } from "zod";
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
  exec?(sql: string): void;
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const observationUsageSchema = z.object({
  inputTokens: z.number().int().min(0).nullable().default(null),
  outputTokens: z.number().int().min(0).nullable().default(null),
  cacheReadTokens: z.number().int().min(0).nullable().default(null),
  cacheWriteTokens: z.number().int().min(0).nullable().default(null),
  /**
   * M7.5 — reported spend in USD, derived from the provider's
   * observed token counts using the run's pinned pricing tier.
   * `null` means the provider reported no usage (no compute ⇒ no
   * cost). Negative values are rejected (no credits on the
   * observation surface; compensation is a separate operation).
   */
  costUsd: z.number().nonnegative().nullable().default(null),
  /**
   * M7.5 — pinned pricing-tier digest (sha256 of the
   * pricing-catalog row used to derive `costUsd`). Two observations
   * with the same tokens but different digests MUST produce
   * different `costUsd` — the digest makes pricing changes
   * visible in the audit trail. `null` when the provider did not
   * pin a tier (e.g. anonymous / unpriced).
   */
  pricingTierDigest: z.string().regex(SHA256_HEX_RE).nullable().default(null),
}).strict();

export const observationPayloadSchema = z.object({
  startup: z.record(z.string().max(64), z.unknown()),
  exit: z.object({
    at: z.string().datetime(),
    code: z.number().int().nullable(),
    signal: z.string().nullable(),
    reason: z.string().min(1).max(256).nullable().default(null),
  }).strict(),
  usage: observationUsageSchema.nullable().default(null),
}).strict();
export type ObservationPayload = z.input<typeof observationPayloadSchema>;

export interface RecordObservationInput {
  readonly invocationId: string;
  readonly correlationId: string;
  readonly observedAt?: string;
  readonly payload: ObservationPayload;
}

/**
 * Write one observation event. Returns the assigned event `seq`.
 *
 * The caller is expected to have already established the invocation row;
 * `recordObservation` does not create one. Use `commitCursor` (Increment 3)
 * to wrap the observation in the same transaction as the invocation's
 * terminal transition.
 */
export async function recordObservation(
  worker: DbWorker,
  input: RecordObservationInput,
): Promise<{ seq: number }> {
  const payload = observationPayloadSchema.parse(input.payload);
  const driver = driverOf(worker);
  const observedAt = input.observedAt ?? new Date().toISOString();
  const eventType = "provider.observation";
  let nextSeq: number | undefined;
  await worker.transaction(tx => {
    void tx;
    const invocationExists = driver.prepare("SELECT uuid FROM invocation WHERE uuid = ?")
      .first(input.invocationId);
    if (!invocationExists) throw new AppError("NOT_FOUND", "Invocation not found");
    // The in-memory driver does not support `SELECT MAX(seq)+1` as an
    // expression. Order by seq descending to compute the next monotonic
    // value. (`node:sqlite` would happily evaluate `MAX`, but the test
    // driver is the one we have to keep passing.)
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    nextSeq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      nextSeq, observedAt, input.correlationId, "runtime", null, null, null,
      eventType, JSON.stringify(payload),
    );
  });
  if (nextSeq == null) throw new AppError("UNAVAILABLE", "Observation event was not sequenced");
  return { seq: nextSeq };
}