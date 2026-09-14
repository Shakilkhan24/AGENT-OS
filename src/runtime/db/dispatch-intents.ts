/**
 * M3a — `dispatch_intent` entity service.
 *
 * A dispatch_intent is one typed method invocation recorded by the runtime
 * BEFORE it commits to a backend claim. The state machine mirrors the M3
 * gate: `recorded → claimed → spawned → acked`, with `expired` reachable
 * from `recorded` or `claimed` (deadline exceeded before spawn).
 *
 * The intent is the audit anchor for "what the runtime tried to do". An
 * intent survives across reconnects; an `acked` intent means the result
 * has been observed and the caller's request is durably committed.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { dispatchIntentRowSchema } from "./schema";
import { dispatchIntentStateSchema, type DispatchIntent, type DispatchIntentState } from "../../shared/managed";
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

const INTENT_TRANSITIONS: Record<DispatchIntentState, ReadonlyArray<DispatchIntentState>> = {
  recorded: ["claimed", "expired"],
  claimed: ["spawned", "expired"],
  spawned: ["acked"],
  acked: [],
  expired: [],
};

const recordIntentSchema = z.object({
  runId: z.string().uuid(),
  invocationId: z.string().uuid().nullable().default(null),
  method: z.string().min(1).max(128),
  args: z.unknown().default({}),
  scope: z.unknown().default({}),
  deadlineAt: z.string().datetime(),
}).strict();
export type RecordIntentInput = z.input<typeof recordIntentSchema>;

export async function recordDispatchIntent(worker: DbWorker, input: RecordIntentInput): Promise<DispatchIntent> {
  const parsed = recordIntentSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const runExists = driver.prepare("SELECT uuid FROM run WHERE uuid = ?").first(parsed.runId);
    if (!runExists) throw new AppError("NOT_FOUND", "Run not found");
    driver.prepare(
      "INSERT INTO dispatch_intent (uuid, run_id, invocation_id, method, args_json, scope_json, " +
      "deadline_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.runId, parsed.invocationId, parsed.method,
      JSON.stringify(parsed.args), JSON.stringify(parsed.scope),
      parsed.deadlineAt, "recorded", now,
    );
  });
  const read = await readDispatchIntent(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "DispatchIntent disappeared after insert");
  return read;
}

export async function readDispatchIntent(worker: DbWorker, id: string): Promise<DispatchIntent | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM dispatch_intent WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseIntentRow(row);
}

export async function transitionDispatchIntent(worker: DbWorker, id: string, to: DispatchIntentState): Promise<DispatchIntent> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT state FROM dispatch_intent WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "DispatchIntent not found");
    const from = dispatchIntentStateSchema.parse(String((row as Record<string, unknown>).state));
    if (!INTENT_TRANSITIONS[from].includes(to))
      throw new AppError("CONFLICT", `Illegal dispatch_intent transition ${from} → ${to}`);
    driver.prepare("UPDATE dispatch_intent SET state = ? WHERE uuid = ?").run(to, id);
  });
  const after = await readDispatchIntent(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "DispatchIntent disappeared after transition");
  return after;
}

export async function listDispatchIntentsForRun(worker: DbWorker, runId: string): Promise<DispatchIntent[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM dispatch_intent WHERE run_id = ? ORDER BY created_at ASC").all(runId);
  return rows.map(parseIntentRow);
}

function parseIntentRow(row: Record<string, unknown>): DispatchIntent {
  const parsed = dispatchIntentRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    runId: String(row.run_id),
    invocationId: row.invocation_id == null ? null : String(row.invocation_id),
    method: String(row.method),
    argsJson: String(row.args_json),
    scopeJson: String(row.scope_json),
    deadlineAt: String(row.deadline_at),
    state: String(row.state),
    createdAt: String(row.created_at),
  });
  return { ...parsed, id: parsed.uuid };
}