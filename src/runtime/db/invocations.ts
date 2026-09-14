/**
 * M3a — `invocation` entity service.
 *
 * An invocation is one provider round-trip inside a run. It carries the
 * idempotency key (so retry yields the same handle) and the canonical
 * digest of the request (so a replay against a stale input refuses).
 *
 * The status state machine:
 *   pending → admitted → spawned → observing → done
 *                                            ↘ error
 *
 * `error` is reachable from any non-terminal state; `done` is reachable
 * only from `observing`. A failed admission keeps the invocation `pending`
 * (the caller can retry with a higher `attempt` and a different idem key).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { invocationRowSchema } from "./schema";
import { invocationStatusSchema, type Invocation, type InvocationStatus } from "../../shared/managed";
import type { DbWorker } from "./worker";

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

const INVOCATION_TRANSITIONS: Record<InvocationStatus, ReadonlyArray<InvocationStatus>> = {
  pending: ["admitted", "error"],
  admitted: ["spawned", "error"],
  spawned: ["observing", "error"],
  observing: ["done", "error"],
  done: [],
  error: [],
};

const createInvocationSchema = z.object({
  runId: z.string().uuid(),
  attempt: z.number().int().min(1).max(1024).default(1),
  idempotencyKey: z.string().trim().min(1).max(256),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
}).strict();
export type CreateInvocationInput = z.input<typeof createInvocationSchema>;

export async function createInvocation(worker: DbWorker, input: CreateInvocationInput): Promise<Invocation> {
  const parsed = createInvocationSchema.parse(input);
  const driver = driverOf(worker);
  // Same (runId, idempotencyKey) returns the existing invocation — idempotency
  // for retried callers.
  const existing = driver.prepare("SELECT * FROM invocation WHERE run_id = ? AND idempotency_key = ?")
    .first(parsed.runId, parsed.idempotencyKey);
  if (existing) {
    const parsed2 = parseInvocationRow(existing);
    if (parsed2.canonicalDigest !== parsed.canonicalDigest)
      throw new AppError("CONFLICT", `Idempotency key ${parsed.idempotencyKey} was reused with a different request digest`);
    return parsed2;
  }
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const runExists = driver.prepare("SELECT uuid FROM run WHERE uuid = ?").first(parsed.runId);
    if (!runExists) throw new AppError("NOT_FOUND", "Run not found");
    driver.prepare(
      "INSERT INTO invocation (uuid, run_id, attempt, status, idempotency_key, canonical_digest, " +
      "provider_version, model, account_mode, started_at, ended_at, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.runId, parsed.attempt, "pending",
      parsed.idempotencyKey, parsed.canonicalDigest,
      parsed.providerVersion, parsed.model, parsed.accountMode,
      null, null, now,
    );
  });
  const read = await readInvocation(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Invocation disappeared after insert");
  return read;
}

export async function readInvocation(worker: DbWorker, id: string): Promise<Invocation | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM invocation WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseInvocationRow(row);
}

export async function listInvocationsForRun(worker: DbWorker, runId: string): Promise<Invocation[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM invocation WHERE run_id = ? ORDER BY created_at ASC").all(runId);
  return rows.map(parseInvocationRow);
}

export async function transitionInvocation(worker: DbWorker, id: string, to: InvocationStatus): Promise<Invocation> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM invocation WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Invocation not found");
    const from = invocationStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!INVOCATION_TRANSITIONS[from].includes(to))
      throw new AppError("CONFLICT", `Illegal invocation transition ${from} → ${to}`);
    const now = new Date().toISOString();
    const updates: string[] = ["status = ?"];
    const values: unknown[] = [to];
    if (to === "admitted") { updates.push("started_at = ?"); values.push(now); }
    if (to === "done" || to === "error") { updates.push("ended_at = ?"); values.push(now); }
    values.push(id);
    driver.prepare(`UPDATE invocation SET ${updates.join(", ")} WHERE uuid = ?`).run(...values);
  });
  const after = await readInvocation(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Invocation disappeared after transition");
  return after;
}

function parseInvocationRow(row: Record<string, unknown>): Invocation {
  const parsed = invocationRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    runId: String(row.run_id),
    attempt: Number(row.attempt ?? 1),
    status: String(row.status),
    idempotencyKey: String(row.idempotency_key),
    canonicalDigest: String(row.canonical_digest),
    providerVersion: String(row.provider_version ?? ""),
    model: String(row.model ?? ""),
    accountMode: String(row.account_mode ?? "anonymous"),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    createdAt: String(row.created_at),
  });
  return { ...parsed, id: parsed.uuid };
}