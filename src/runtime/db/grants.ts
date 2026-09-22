/**
 * M3a — `grant` entity service.
 *
 * A grant is a typed authority a principal asks for. The state machine:
 *   pending → approved | denied | expired
 *
 * Grants are NEVER self-approved: `decideGrant` is the only path that flips
 * state to `approved`/`denied`, and the caller must supply a `decidedBy`
 * principal distinct from the grant's requester. The runtime derives the
 * requester's principal from the authenticated connection; tests pass an
 * explicit principal so the policy is observable without a real socket.
 *
 * Grants are scoped to a task (or unattached — used for global capability
 * probes). The `scope` and `digests` are stored as JSON strings because
 * they're caller-shaped and not part of the schema's invariant surface.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { grantRowSchema } from "./schema";
import { grantKindSchema, grantStateSchema, type Grant, type GrantState } from "../../shared/managed";
import { probeCapabilities } from "./capabilities";
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

const requestGrantSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  kind: grantKindSchema,
  scope: z.unknown().default({}),
  principal: z.string().min(1).max(256),
  digests: z.record(z.string().max(80), z.string().regex(/^[0-9a-f]{64}$/)).default({}),
  restrictions: z.array(z.string().min(1).max(64)).default([]),
}).strict();
export type RequestGrantInput = z.input<typeof requestGrantSchema>;

export async function requestGrant(worker: DbWorker, input: RequestGrantInput): Promise<Grant> {
  const parsed = requestGrantSchema.parse(input);
  const caps = await probeCapabilities();
  const unsupported = parsed.restrictions.filter(restriction =>
    caps.unsupportedRestrictions.includes(restriction),
  );
  if (unsupported.length > 0)
    throw new AppError("UNSUPPORTED_RESTRICTION",
      `Requested restriction(s) not supported by this host: ${unsupported.join(", ")}`,
      { sourceId: "grants" });
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO grant (uuid, task_id, kind, scope_json, principal, digests_json, state, " +
      "requested_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.taskId, parsed.kind,
      JSON.stringify(parsed.scope),
      parsed.principal,
      JSON.stringify(parsed.digests),
      "pending", now, null, null,
    );
  });
  const read = await readGrant(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Grant disappeared after insert");
  return read;
}

export async function readGrant(worker: DbWorker, id: string): Promise<Grant | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM grant WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseGrantRow(row);
}

const DECISION_INPUT = z.object({
  decision: z.enum(["approve", "deny", "expire"]),
  decidedBy: z.string().min(1).max(256),
}).strict();
export type DecideGrantInput = z.input<typeof DECISION_INPUT>;

/**
 * Decide a pending grant. Refuses to decide an already-decided grant;
 * refuses to self-approve (decidedBy == principal). Returns the updated row.
 */
export async function decideGrant(worker: DbWorker, id: string, input: DecideGrantInput): Promise<Grant> {
  const parsed = DECISION_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM grant WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Grant not found");
    const r = row as Record<string, unknown>;
    const state = grantStateSchema.parse(String(r.state));
    if (state !== "pending")
      throw new AppError("CONFLICT", `Grant already ${state}; refusing to re-decide`);
    const requester = String(r.principal);
    if (parsed.decision === "approve" && parsed.decidedBy === requester)
      throw new AppError("CONFLICT", "Grants cannot be self-approved — decidedBy must differ from requester principal");
    const next: GrantState = parsed.decision === "approve" ? "approved" : parsed.decision === "deny" ? "denied" : "expired";
    driver.prepare("UPDATE grant SET state = ?, decided_at = ?, decided_by = ? WHERE uuid = ?")
      .run(next, new Date().toISOString(), parsed.decidedBy, id);
  });
  const after = await readGrant(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Grant disappeared after decision");
  return after;
}

export async function listGrants(worker: DbWorker, filter?: { state?: GrantState; taskId?: string }): Promise<Grant[]> {
  const driver = driverOf(worker);
  return driver.prepare("SELECT * FROM grant").all()
    .map(parseGrantRow)
    .filter(grant => {
      if (filter?.state && grant.state !== filter.state) return false;
      if (filter?.taskId && grant.taskId !== filter.taskId) return false;
      return true;
    });
}

function parseGrantRow(row: Record<string, unknown>): Grant {
  const parsed = grantRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    kind: String(row.kind),
    scopeJson: String(row.scope_json ?? "{}"),
    principal: String(row.principal ?? ""),
    digestsJson: String(row.digests_json ?? "{}"),
    state: String(row.state),
    requestedAt: String(row.requested_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
  });
  return { ...parsed, id: parsed.uuid };
}