/**
 * M4.5.b — MCP endpoint authority.
 *
 * The M4.5 line "keep added powers unavailable until authorized"
 * is the core gate this module enforces. Authority is split across
 * two storage layers:
 *  - **Identity row** (`mcp-endpoint:<endpointId>`) records
 *    `approvedSnapshotDigest`. Set by `approveEndpointSnapshot`.
 *  - **Grant rows** (existing `grant` table, `kind: "authority"`)
 *    record the user's authorisation. The grant's `scopeJson`
 *    carries `{endpointId, addedPowers: string[]}`.
 *
 * Power `P` is authorised for endpoint `E` iff BOTH:
 *  1. The identity row exists AND its `approvedSnapshotDigest`
 *     resolves to a snapshot that contains a tool whose `name`
 *     equals `P`.
 *  2. A grant of `kind: "authority"` exists for endpoint `E`
 *     with `state === "approved"` AND `P ∈ addedPowers`.
 *
 * The split mirrors the M4.2 pattern: the identity row records
 * "what was approved" and the grant records "who approved it and
 * for which powers". A future renderer (M5+) can present both
 * views side-by-side.
 *
 * Drift detection (`refreshEndpointDiscovery`) compares a fresh
 * discovery result against the approved snapshot's tools and
 * reports `addedTools`, `removedTools`, `changedTools` (by digest
 * comparison). The function does NOT mutate the identity row —
 * the caller decides whether to surface this for re-approval.
 *
 * The "added powers" model is the diff against an empty baseline:
 * every tool in the approved snapshot is, by definition, an
 * "added power" because the baseline grants nothing. A future
 * baseline-permissions mechanism can replace the empty array
 * without changing the function signature.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ZodError } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import {
  type McpEndpointRow,
  type McpToolSnapshot,
  MCP_ENDPOINT_META_PREFIX,
  mcpToolSnapshotSchema,
  MCP_TOOL_SNAPSHOT_META_PREFIX,
  readEndpointRow,
  snapshotKey,
} from "./mcp-endpoint";
import { listGrants } from "./grants";
import { stableStringify } from "./effective-settings";

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

/**
 * Compute the "added powers" diff for a snapshot against an empty
 * baseline. Today the baseline is `[]` (no permissions granted
 * unconditionally), so the result is the snapshot's full tool
 * name list. A future baseline-permissions row can replace the
 * empty array without changing the signature.
 */
export function computeAddedPowers(snapshot: McpToolSnapshot): string[] {
  // Diff against the empty baseline: every tool name in the
  // snapshot is "added". Sorted for stable output.
  return [...new Set(snapshot.tools.map((t) => t.name))].sort();
}

/**
 * Compute the SHA-256 snapshot digest for a fresh discovery
 * result without recording it. Used by `refreshEndpointDiscovery`
 * to detect drift against the approved snapshot.
 *
 * Note: `capturedAt` is intentionally NOT part of the canonical
 * input. Drift detection is about tool-set equality, not
 * "captured at this exact millisecond". A re-record at a later
 * time with identical tools yields the same digest.
 */
function digestForTools(input: {
  endpointId: string;
  transportRevision: string;
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
}): string {
  const descriptors = input.tools.map((t) => ({
    name: t.name,
    descriptionDigest: createHash("sha256").update(t.description, "utf8").digest("hex"),
    inputSchemaDigest: createHash("sha256").update(stableStringify(t.inputSchema), "utf8").digest("hex"),
  }));
  return createHash("sha256")
    .update(
      stableStringify({
        endpointId: input.endpointId,
        transportRevision: input.transportRevision,
        tools: descriptors,
        snapshotDigest: "",
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Diff two snapshots by name. Tools present in `b` but not `a`
 * are `addedTools`; tools present in `a` but not `b` are
 * `removedTools`; tools present in both whose digests differ are
 * `changedTools`. Tools whose `name` is unchanged and digests
 * match are absent from all three arrays.
 */
function diffTools(a: McpToolSnapshot, b: McpToolSnapshot): {
  addedTools: string[];
  removedTools: string[];
  changedTools: string[];
} {
  const aMap = new Map(a.tools.map((t) => [t.name, t]));
  const bMap = new Map(b.tools.map((t) => [t.name, t]));
  const addedTools: string[] = [];
  const removedTools: string[] = [];
  const changedTools: string[] = [];
  for (const [name, bTool] of bMap) {
    const aTool = aMap.get(name);
    if (!aTool) {
      addedTools.push(name);
      continue;
    }
    if (
      aTool.descriptionDigest !== bTool.descriptionDigest ||
      aTool.inputSchemaDigest !== bTool.inputSchemaDigest
    ) {
      changedTools.push(name);
    }
  }
  for (const [name] of aMap) {
    if (!bMap.has(name)) removedTools.push(name);
  }
  return {
    addedTools: addedTools.sort(),
    removedTools: removedTools.sort(),
    changedTools: changedTools.sort(),
  };
}

export type RefreshKind = "unchanged" | "drift";

export interface RefreshResult {
  readonly kind: RefreshKind;
  readonly previousDigest: string | null;
  readonly newDigest: string;
  readonly addedTools: string[];
  readonly removedTools: string[];
  readonly changedTools: string[];
}

/**
 * Compare a fresh discovery result against the approved snapshot
 * for an endpoint. Returns `kind: "unchanged"` when the fresh
 * digest matches the approved one, otherwise `kind: "drift"`
 * with a structural diff.
 *
 * Pure: does not mutate the identity row or write to storage. The
 * caller decides whether to surface drift for re-approval.
 */
export function refreshEndpointDiscovery(
  worker: DbWorker,
  input: {
    endpointId: string;
    transportRevision: string;
    tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
  },
): RefreshResult {
  const row = readEndpointRow(worker, input.endpointId);
  // `previousDigest` is null when the endpoint has never been
  // approved; that's a "drift" case (the caller has no approved
  // baseline) and the diff is "everything is added".
  const previousDigest = row?.approvedSnapshotDigest ?? null;
  const newDigest = digestForTools({
    endpointId: input.endpointId,
    transportRevision: input.transportRevision,
    tools: input.tools,
  });
  if (previousDigest === newDigest) {
    return {
      kind: "unchanged",
      previousDigest,
      newDigest,
      addedTools: [],
      removedTools: [],
      changedTools: [],
    };
  }
  // To produce the structural diff we need the previous snapshot
  // — read it from the snapshot ledger. If the previous digest
  // is missing (no prior approval) we report everything as added.
  let addedTools: string[] = [];
  let removedTools: string[] = [];
  let changedTools: string[] = [];
  if (previousDigest !== null) {
    const previous = readSnapshotByDigest(worker, input.endpointId, previousDigest);
    if (previous) {
      const constructedNew: McpToolSnapshot = {
        endpointId: input.endpointId,
        transportRevision: input.transportRevision,
        capturedAt: new Date().toISOString(),
        tools: input.tools.map((t) => ({
          name: t.name,
          descriptionDigest: createHash("sha256").update(t.description, "utf8").digest("hex"),
          inputSchemaDigest: createHash("sha256").update(stableStringify(t.inputSchema), "utf8").digest("hex"),
        })),
        snapshotDigest: newDigest,
      };
      const diff = diffTools(previous, constructedNew);
      addedTools = diff.addedTools;
      removedTools = diff.removedTools;
      changedTools = diff.changedTools;
    } else {
      // Approved digest doesn't match any stored snapshot —
      // treat as "everything is added" so the renderer flags it
      // for re-approval.
      addedTools = [...new Set(input.tools.map((t) => t.name))].sort();
    }
  } else {
    addedTools = [...new Set(input.tools.map((t) => t.name))].sort();
  }
  return {
    kind: "drift",
    previousDigest,
    newDigest,
    addedTools,
    removedTools,
    changedTools,
  };
}

/**
 * Point a endpoint's identity row at an approved snapshot. The
 * caller (renderer / M5 IPC) is responsible for also creating an
 * `"authority"` grant; this function only updates the identity
 * row's `approvedSnapshotDigest`.
 *
 * Refuses to approve a snapshot digest that is not present in the
 * snapshot ledger so a typo cannot silently mark a non-existent
 * snapshot as approved.
 */
export function approveEndpointSnapshot(
  worker: DbWorker,
  input: {
    endpointId: string;
    snapshotDigest: string;
    approvedBy: string;
  },
): McpEndpointRow {
  const row = readEndpointRow(worker, input.endpointId);
  if (!row) {
    throw new AppError("NOT_FOUND", `MCP endpoint "${input.endpointId}" is not recorded`);
  }
  if (!/^[0-9a-f]{64}$/.test(input.snapshotDigest)) {
    throw new AppError("INVALID_REQUEST", `Snapshot digest must be a 64-hex string`);
  }
  // The snapshot must exist in the ledger; otherwise we refuse.
  const found = readSnapshotByDigest(worker, input.endpointId, input.snapshotDigest);
  if (!found) {
    throw new AppError(
      "CONFLICT",
      `Snapshot digest ${input.snapshotDigest} is not recorded for endpoint ${input.endpointId}`,
    );
  }
  const updated: McpEndpointRow = {
    ...row,
    approvedSnapshotDigest: input.snapshotDigest,
    capturedAt: new Date().toISOString(),
  };
  const driver = driverOf(worker);
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(`${MCP_TOOL_SNAPSHOT_META_PREFIX}approved-${input.endpointId}`, JSON.stringify({ approvedBy: input.approvedBy, snapshotDigest: input.snapshotDigest, approvedAt: updated.capturedAt }));
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(`${MCP_ENDPOINT_META_PREFIX}${input.endpointId}`, JSON.stringify(updated));
  return updated;
}

/** True iff the endpoint's identity row has an `approvedSnapshotDigest`. */
export function isEndpointAuthorized(worker: DbWorker, endpointId: string): boolean {
  const row = readEndpointRow(worker, endpointId);
  return row !== undefined && row.approvedSnapshotDigest !== null;
}

/** Reason codes for `isPowerAuthorized`. Each maps to a specific renderer message. */
export type PowerAuthorizationReason =
  | "no-endpoint"
  | "no-snapshot"
  | "no-grant"
  | "grant-pending"
  | "grant-denied"
  | "power-unlisted"
  | "ok";

export interface PowerAuthorization {
  readonly authorized: boolean;
  readonly reason: PowerAuthorizationReason;
}

const authorityScopeSchema = z
  .object({
    endpointId: z.string().uuid(),
    addedPowers: z.array(z.string().min(1).max(200)).max(4096),
  })
  .strict();

/**
 * Resolve whether a specific power is authorised for an endpoint.
 * The reason enum lets the renderer render a specific message
 * without re-deriving it.
 *
 * Authority requires BOTH:
 *  - The endpoint is approved (identity row has
 *    `approvedSnapshotDigest`) AND the approved snapshot
 *    contains a tool named `powerName`.
 *  - An authority grant exists in state `"approved"` whose
 *    `scopeJson` parses to `{endpointId, addedPowers: [...]}` and
 *    `powerName ∈ addedPowers`.
 */
export async function isPowerAuthorized(
  worker: DbWorker,
  input: { endpointId: string; powerName: string },
): Promise<PowerAuthorization> {
  if (input.powerName.length === 0 || input.powerName.length > 200) {
    throw new AppError("INVALID_REQUEST", "powerName must be 1..200 characters");
  }
  const row = readEndpointRow(worker, input.endpointId);
  if (!row) return { authorized: false, reason: "no-endpoint" };
  if (row.approvedSnapshotDigest === null) {
    return { authorized: false, reason: "no-snapshot" };
  }
  const snapshot = readSnapshotByDigest(worker, input.endpointId, row.approvedSnapshotDigest);
  if (!snapshot) {
    // The approved digest points at a missing snapshot — treat
    // as "no snapshot" so the renderer prompts re-approval.
    return { authorized: false, reason: "no-snapshot" };
  }
  const toolNames = new Set(snapshot.tools.map((t) => t.name));
  if (!toolNames.has(input.powerName)) {
    return { authorized: false, reason: "power-unlisted" };
  }

  // Now check the grant ledger. `listGrants({taskId: null})`
  // returns grants whose `task_id IS NULL`; the per-endpoint
  // authority scope is identified by `scope_json` containing
  // `{endpointId: <this-id>, addedPowers: [...]}`.
  const grants = await listGrants(worker);
  const candidates = grants.filter((g) => {
    if (g.kind !== "authority") return false;
    try {
      const parsed = authorityScopeSchema.parse(JSON.parse(g.scopeJson));
      return parsed.endpointId === input.endpointId;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) {
    return { authorized: false, reason: "no-grant" };
  }
  // Pick the most-decided grant. Approved wins over pending,
  // pending wins over denied/expired.
  const approved = candidates.find((g) => g.state === "approved");
  if (approved) {
    const parsed = authorityScopeSchema.parse(JSON.parse(approved.scopeJson));
    if (parsed.addedPowers.includes(input.powerName)) {
      return { authorized: true, reason: "ok" };
    }
    return { authorized: false, reason: "power-unlisted" };
  }
  const pending = candidates.find((g) => g.state === "pending");
  if (pending) return { authorized: false, reason: "grant-pending" };
  return { authorized: false, reason: "grant-denied" };
}

/** Test seam: read a snapshot by its digest. Returns undefined when absent. */
function readSnapshotByDigest(
  worker: DbWorker,
  endpointId: string,
  digest: string,
): McpToolSnapshot | undefined {
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT value FROM meta WHERE key = ?`).first(snapshotKey(endpointId, digest));
  if (!row) return undefined;
  const raw = String(row.value ?? "");
  if (!raw) return undefined;
  try {
    return mcpToolSnapshotSchema.parse(JSON.parse(raw));
  } catch (err) {
    if (err instanceof ZodError) return undefined;
    return undefined;
  }
}
