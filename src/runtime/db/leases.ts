/**
 * M3a — `lease` entity service.
 *
 * A managed write lease pins a workspace to a single controller so two
 * writers cannot edit the same checkout concurrently. The lease carries
 * a fencing token; downstream code MUST pin the token onto every mutation
 * it issues so a stale writer is rejected even after a lease handoff.
 *
 * Lease state machine:
 *   held → released          (the holder explicitly hands the workspace back)
 *   held → uncertain         (the holder became unresponsive — caller must
 *                             inspect the workspace before releasing)
 *   held → expired           (TTL elapsed; only an inspection call may
 *                             release a lease the controller did not)
 *
 * A lease is acquired with `acquireLease` and released with `releaseLease`.
 * Renewing an active lease bumps `fencingToken` and extends the TTL.
 * `markUncertain` is the path the runtime uses when it cannot reach the
 * holder — the lease is left non-held so an inspection call decides.
 *
 * Only one lease may be `held` per workspace at a time; the composite
 * unique index `(workspace_id) WHERE state = 'held'` enforces it at the
 * engine.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { leaseRowSchema } from "./schema";
import { leaseStateSchema, type Lease, type LeaseState } from "../../shared/managed";
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

/** Default lease TTL — long enough for a slow edit, short enough that a crashed controller is contained. */
export const DEFAULT_LEASE_MS = 5 * 60 * 1000;

const acquireSchema = z.object({
  workspaceId: z.string().uuid(),
  holder: z.string().min(1).max(256),
  ttlMs: z.number().int().min(1_000).max(60 * 60 * 1000).default(DEFAULT_LEASE_MS),
}).strict();
export type AcquireLeaseInput = z.input<typeof acquireSchema>;

export async function acquireLease(worker: DbWorker, input: AcquireLeaseInput): Promise<Lease> {
  const parsed = acquireSchema.parse(input);
  const driver = driverOf(worker);
  // Refuse to acquire a lease while another holder still claims the workspace.
  const existing = driver.prepare("SELECT * FROM lease WHERE workspace_id = ? AND state = 'held'")
    .first(parsed.workspaceId);
  if (existing) {
    const live = parseLeaseRow(existing);
    // Expired TTL — the holder is presumed gone. Surface as LEASE_HELD so a
    // human can inspect before the caller tries to reclaim.
    if (new Date(live.expiresAt).getTime() > Date.now()) {
      throw new AppError("LEASE_HELD",
        `Workspace ${parsed.workspaceId} already has a live lease held by ${live.holder}`);
    }
    // Expired but un-released: mark uncertain so the next caller decides.
    driver.prepare("UPDATE lease SET state = ?, released_at = ? WHERE uuid = ?")
      .run("uncertain", new Date().toISOString(), live.id);
  }
  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + parsed.ttlMs);
  await worker.transaction(tx => {
    void tx;
    const workspaceExists = driver.prepare("SELECT uuid FROM workspace WHERE uuid = ?").first(parsed.workspaceId);
    if (!workspaceExists) throw new AppError("NOT_FOUND", "Workspace not found");
    try {
      driver.prepare(
        "INSERT INTO lease (uuid, workspace_id, holder, state, acquired_at, expires_at, " +
        "renewed_at, released_at, fencing_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id, parsed.workspaceId, parsed.holder, "held",
        now.toISOString(), expires.toISOString(), null, null, 1,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE/.test(message))
        throw new AppError("LEASE_HELD", `Workspace ${parsed.workspaceId} is concurrently held`);
      throw error;
    }
    driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ?").run(id, parsed.workspaceId);
  });
  const read = await readLease(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Lease disappeared after acquire");
  return read;
}

export async function readLease(worker: DbWorker, id: string): Promise<Lease | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM lease WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseLeaseRow(row);
}

export async function listLeasesForWorkspace(worker: DbWorker, workspaceId: string): Promise<Lease[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM lease WHERE workspace_id = ? ORDER BY acquired_at ASC").all(workspaceId);
  return rows.map(parseLeaseRow);
}

/** Flat lister over every lease in the workspace. Used by M3c.1 projections. */
export async function listLeases(worker: DbWorker): Promise<Lease[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM lease ORDER BY acquired_at ASC").all();
  return rows.map(parseLeaseRow);
}

export async function readActiveLease(worker: DbWorker, workspaceId: string): Promise<Lease | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM lease WHERE workspace_id = ? AND state = 'held' ORDER BY acquired_at DESC LIMIT 1")
    .first(workspaceId);
  return row ? parseLeaseRow(row) : undefined;
}

export async function renewLease(worker: DbWorker, id: string, ttlMs: number = DEFAULT_LEASE_MS): Promise<Lease> {
  const driver = driverOf(worker);
  let nextToken = 0;
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM lease WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Lease not found");
    const current = parseLeaseRow(row);
    if (current.state !== "held")
      throw new AppError("CONFLICT", `Cannot renew ${current.state} lease`);
    if (new Date(current.expiresAt).getTime() < Date.now())
      throw new AppError("LEASE_UNCERTAIN", `Lease ${id} expired before renewal`);
    nextToken = current.fencingToken + 1;
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMs);
    driver.prepare("UPDATE lease SET renewed_at = ?, expires_at = ?, fencing_token = ? WHERE uuid = ?")
      .run(now.toISOString(), expires.toISOString(), nextToken, id);
  });
  const after = await readLease(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Lease disappeared after renew");
  return after;
}

const releaseSchema = z.object({
  by: z.string().min(1).max(256),
}).strict();
export type ReleaseLeaseInput = z.input<typeof releaseSchema>;

/**
 * Release a held lease. The holder field on the lease must equal `by` so
 * a different controller cannot free someone else's lease by mistake.
 * For uncertain/expired leases the caller must use `markUncertain` or
 * `expireLease` first — releasing them skips the holder check because
 * the holder is presumed gone.
 */
export async function releaseLease(worker: DbWorker, id: string, input: ReleaseLeaseInput): Promise<Lease> {
  const parsed = releaseSchema.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM lease WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Lease not found");
    const current = parseLeaseRow(row);
    if (current.state === "released")
      throw new AppError("CONFLICT", `Lease ${id} is already released`);
    if (current.state === "held" && current.holder !== parsed.by)
      throw new AppError("CONFLICT", `Holder mismatch: lease held by ${current.holder}, release requested by ${parsed.by}`);
    driver.prepare("UPDATE lease SET state = ?, released_at = ? WHERE uuid = ?")
      .run("released", new Date().toISOString(), id);
    driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ? AND lease_id = ?")
      .run(null, current.workspaceId, id);
  });
  const after = await readLease(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Lease disappeared after release");
  return after;
}

const MARK_INPUT = z.object({
  by: z.string().min(1).max(256),
  reason: z.string().min(1).max(256).optional(),
}).strict();
export type MarkUncertainInput = z.input<typeof MARK_INPUT>;

/**
 * Mark a held lease as `uncertain` — the runtime tried to reach the
 * holder and failed. The workspace must be inspected (another checkout
 * used, or the old writer reconciled) before any new lease may acquire.
 * The fence token is preserved so any stale write from the old holder
 * is still rejected.
 */
export async function markUncertain(worker: DbWorker, id: string, input: MarkUncertainInput): Promise<Lease> {
  const parsed = MARK_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM lease WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Lease not found");
    const current = parseLeaseRow(row);
    if (current.state !== "held")
      throw new AppError("CONFLICT", `Cannot mark ${current.state} lease as uncertain`);
    if (current.holder !== parsed.by)
      throw new AppError("CONFLICT", `Holder mismatch: lease held by ${current.holder}, mark requested by ${parsed.by}`);
    driver.prepare("UPDATE lease SET state = ?, released_at = ? WHERE uuid = ?")
      .run("uncertain", new Date().toISOString(), id);
    driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ? AND lease_id = ?")
      .run(null, current.workspaceId, id);
  });
  const after = await readLease(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Lease disappeared after mark");
  return after;
}

/**
 * Force a lease to `expired` once its TTL has elapsed without a renewal.
 * This is the path that prevents a crashed controller's lease from
 * blocking a new writer indefinitely; the new caller must inspect the
 * workspace before continuing (lease is left non-held so acquireLease
 * succeeds after this call).
 */
export async function expireLease(worker: DbWorker, id: string): Promise<Lease> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM lease WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Lease not found");
    const current = parseLeaseRow(row);
    if (current.state !== "held")
      throw new AppError("CONFLICT", `Cannot expire ${current.state} lease`);
    if (new Date(current.expiresAt).getTime() > Date.now())
      throw new AppError("CONFLICT", `Lease ${id} has not yet expired`);
    driver.prepare("UPDATE lease SET state = ?, released_at = ? WHERE uuid = ?")
      .run("expired", new Date().toISOString(), id);
    driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ? AND lease_id = ?")
      .run(null, current.workspaceId, id);
  });
  const after = await readLease(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Lease disappeared after expire");
  return after;
}

const TRANSITION_INPUT = z.object({
  to: leaseStateSchema,
}).strict();
export type LeaseTransitionInput = z.input<typeof TRANSITION_INPUT>;

/**
 * Generic state transition with an explicit allow-list. Used by tests
 * and admin tooling; production callers should prefer `releaseLease`,
 * `markUncertain`, or `expireLease` for the explicit invariants they
 * each enforce.
 */
export async function transitionLease(worker: DbWorker, id: string, input: LeaseTransitionInput): Promise<Lease> {
  const parsed = TRANSITION_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT state, workspace_id FROM lease WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Lease not found");
    const from = leaseStateSchema.parse(String((row as Record<string, unknown>).state));
    const workspaceId = String((row as Record<string, unknown>).workspace_id);
    const allowed = LEASE_TRANSITIONS[from].includes(parsed.to);
    if (!allowed)
      throw new AppError("CONFLICT", `Illegal lease transition ${from} → ${parsed.to}`);
    const now = new Date().toISOString();
    if (parsed.to === "released" || parsed.to === "expired" || parsed.to === "uncertain") {
      driver.prepare("UPDATE lease SET state = ?, released_at = ? WHERE uuid = ?")
        .run(parsed.to, now, id);
      driver.prepare("UPDATE workspace SET lease_id = ? WHERE uuid = ? AND lease_id = ?")
        .run(null, workspaceId, id);
    } else {
      driver.prepare("UPDATE lease SET state = ? WHERE uuid = ?").run(parsed.to, id);
    }
  });
  const after = await readLease(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Lease disappeared after transition");
  return after;
}

const LEASE_TRANSITIONS: Record<LeaseState, ReadonlyArray<LeaseState>> = {
  held: ["released", "uncertain", "expired"],
  released: [],
  uncertain: ["released", "expired"],
  expired: [],
};

function parseLeaseRow(row: Record<string, unknown>): Lease {
  const parsed = leaseRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    workspaceId: String(row.workspace_id),
    holder: String(row.holder),
    state: String(row.state),
    acquiredAt: String(row.acquired_at),
    expiresAt: String(row.expires_at),
    renewedAt: row.renewed_at == null ? null : String(row.renewed_at),
    releasedAt: row.released_at == null ? null : String(row.released_at),
    fencingToken: Number(row.fencing_token ?? 0),
  });
  return { ...parsed, id: parsed.uuid };
}