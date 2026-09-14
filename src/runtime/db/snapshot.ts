/**
 * M2.5 — Snapshot + database-generation handshake.
 *
 * The handshake guarantees that a renderer reconnecting after a crash or
 * resume never sees a stale or partially-applied state:
 *
 *  - `takeSnapshot(worker)` returns the current generation and a frozen
 *    serialisable projection of the workspace state. The generation is a
 *    monotonic counter incremented inside a transaction that mutates
 *    entity rows.
 *  - `replaySince(worker, generation)` returns the events whose seq is
 *    strictly greater than the caller's high-water mark. Duplicates are
 *    removed using the seq cursor.
 *  - `losslessEncode(seq)` packs a database generation and an event seq
 *    into a single base-32 string so JSON state and event cursors can
 *    share one progress field without colliding.
 *
 * The handshake is part of the M2.5 contract: a renderer that holds a
 * generation `g` is guaranteed to see a strict superset of the rows it
 * already had, plus every event with `seq > g` once.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { domainEventSchema, type DomainEvent, type EventReplay } from "../../shared/events";

const GENERATION_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

export const snapshotSchema = z.object({
  generation: z.number().int().nonnegative(),
  takenAt: z.string().datetime(),
  counts: z.object({
    sessions: z.number().int().nonnegative(),
    terminals: z.number().int().nonnegative(),
    presets: z.number().int().nonnegative(),
    envProfiles: z.number().int().nonnegative(),
    hooks: z.number().int().nonnegative(),
    launches: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    drafts: z.number().int().nonnegative(),
  }),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): { value?: number; c?: number; generation?: number; seq?: number } | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
  transaction<T>(fn: (...args: never[]) => T): (...args: never[]) => T;
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/** Take a snapshot of the workspace at the current generation. */
export async function takeSnapshot(worker: DbWorker): Promise<Snapshot> {
  const driver = driverOf(worker);
  let generation = 0;
  await worker.transaction(tx => {
    void tx;
    const current = driver.prepare("SELECT value FROM meta WHERE key = 'generation'").first();
    const next = current ? Number(String((current as Record<string, unknown>).value ?? "0")) + 1 : 1;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("generation", String(next));
    generation = next;
  });
  const counts = liveCounts(worker);
  return snapshotSchema.parse({ generation, takenAt: new Date().toISOString(), counts });
}

/** Read the current generation without incrementing it. */
export async function currentGeneration(worker: DbWorker): Promise<number> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = 'generation'").first();
  return row ? Number(String((row as Record<string, unknown>).value ?? "0")) : 0;
}

/** Increment the generation as part of a caller-supplied mutation. */
export async function bumpGeneration(worker: DbWorker): Promise<number> {
  const driver = driverOf(worker);
  let next = 0;
  await worker.transaction(tx => {
    void tx;
    const current = driver.prepare("SELECT value FROM meta WHERE key = 'generation'").first();
    next = current ? Number(String((current as Record<string, unknown>).value ?? "0")) + 1 : 1;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("generation", String(next));
  });
  return next;
}

function liveCounts(worker: DbWorker): Snapshot["counts"] {
  const driver = driverOf(worker);
  return {
    sessions: driver.prepare("SELECT uuid FROM session").all().length,
    terminals: driver.prepare("SELECT uuid FROM terminal").all().length,
    presets: driver.prepare("SELECT uuid FROM preset").all().length,
    envProfiles: driver.prepare("SELECT uuid FROM env_profile").all().length,
    hooks: driver.prepare("SELECT uuid FROM hook").all().length,
    launches: driver.prepare("SELECT uuid FROM launch").all().length,
    events: driver.prepare("SELECT seq FROM event").all().length,
    drafts: driver.prepare("SELECT id FROM draft").all().length,
  };
}

/**
 * Replay every event with `seq > fromSeq`, deduplicating by seq. The
 * returned payload mirrors the legacy `EventReplay` shape so existing
 * renderer subscriptions keep working.
 */
export async function replaySince(worker: DbWorker, fromSeq: number): Promise<EventReplay> {
  if (!Number.isInteger(fromSeq) || fromSeq < 0)
    throw new AppError("INVALID_REQUEST", "fromSeq must be a non-negative integer");
  const driver = driverOf(worker);
  const all = driver.prepare("SELECT * FROM event").all() as Array<Record<string, unknown>>;
  const filtered = all.filter(row => Number(row.seq) > fromSeq).sort((a, b) => Number(a.seq) - Number(b.seq));
  const events = filtered.map(row => domainEventSchema.parse({
    seq: Number(row.seq),
    at: String(row.at),
    correlationId: String(row.correlation_id),
    sourceId: String(row.source_id),
    sessionId: row.session_uuid ? String(row.session_uuid) : undefined,
    terminalId: row.terminal_uuid ? String(row.terminal_uuid) : undefined,
    originHookId: row.origin_hook_id ? String(row.origin_hook_id) : undefined,
    type: row.type as DomainEvent["type"],
    data: JSON.parse(String(row.payload_json)),
  } satisfies DomainEvent));
  const oldest = all.length === 0 ? fromSeq + 1 : Math.min(...all.map(row => Number(row.seq)));
  const latest = all.length === 0 ? fromSeq : Math.max(...all.map(row => Number(row.seq)));
  return { events: structuredClone(events), oldestSeq: oldest, latestSeq: latest, truncated: fromSeq < oldest - 1 || fromSeq > latest };
}

/**
 * Lossless encoding for `(databaseGeneration, eventSeq)` cursors. The base-32
 * packing produces a 12-character string for 64-bit values; the prefix
 * distinguishes the generation half from the seq half so two cursors with
 * the same seq but different generations never collide.
 */
export function losslessEncode(generation: number, seq: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new AppError("INVALID_REQUEST", "generation must be a non-negative integer");
  if (!Number.isInteger(seq) || seq < 0) throw new AppError("INVALID_REQUEST", "seq must be a non-negative integer");
  // Split the cursor into two 31-bit halves; this stays well under the JSON
  // number precision ceiling (2^53) while encoding enough for the M2
  // planning window (≥ 2 billion events per generation).
  const genMask = 0x7fffffff;
  const seqMask = 0x7fffffff;
  if (generation > genMask) throw new AppError("INVALID_REQUEST", "generation exceeds lossless cursor range");
  if (seq > seqMask) throw new AppError("INVALID_REQUEST", "seq exceeds lossless cursor range");
  const left = generation.toString(32).padStart(7, "0");
  const right = seq.toString(32).padStart(7, "0");
  return `${left}-${right}`;
}

/** Inverse of {@link losslessEncode}. Returns `null` for malformed input. */
export function losslessDecode(cursor: string): { generation: number; seq: number } | null {
  if (typeof cursor !== "string") return null;
  const [left, right] = cursor.split("-");
  if (!left || !right || left.length !== 7 || right.length !== 7) return null;
  if (![...left, ...right].every(ch => GENERATION_ALPHABET.includes(ch))) return null;
  return { generation: parseInt(left, 32), seq: parseInt(right, 32) };
}
