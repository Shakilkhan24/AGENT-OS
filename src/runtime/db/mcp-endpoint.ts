/**
 * M4.5 — MCP endpoint identity + tool-description / schema snapshots.
 *
 * The M4.5 line "An MCP endpoint URL cannot pin remote executable
 * code" means the runtime cannot treat a URL as a substitute for a
 * verified tool inventory. This module introduces the **endpoint
 * identity** record plus the **tool snapshot** ledger so a future
 * M5/M6 increment can plug a real MCP transport in without
 * re-deriving the trust model.
 *
 * Storage:
 *  - identity rows live in the existing `meta` table under
 *    `mcp-endpoint:<endpointId>` carrying
 *    `{endpointId, url, urlHash, transportRevision,
 *    approvedSnapshotDigest, capturedAt}`.
 *  - snapshot rows live under
 *    `mcp-tool-snapshot:<endpointId>:<snapshotDigest>` carrying
 *    the `McpToolSnapshot` payload (content-addressed; the
 *    `<snapshotDigest>` part is itself derived from the contents
 *    so re-recording an identical snapshot is idempotent).
 *
 * Transport revision is hard-coded: M4.5 honours the
 * IMPLEMENTATION-README M4 gate "Pin the actually supported MCP
 * revision; the researched revision is not a universal client
 * guarantee" by refusing any revision other than
 * `MCP_TRANSPORT_REVISION = "2026-07-28"`. A future transport
 * upgrade is a code change, not a config change.
 *
 * The runtime never pins remote executable code via URL. A
 * snapshot is the only thing the runtime trusts: it is the
 * hash-locked record of "the tool inventory at this URL on this
 * transport revision at this capturedAt time".
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { ZodError } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";

/**
 * Pinned MCP transport revision. The IMPLEMENTATION-README M4
 * gate cites
 * `https://modelcontextprotocol.io/specification/2026-07-28/basic/transports`
 * as the researched revision. M4.5 ships only the trust model,
 * not the transport; the constant exists so future transports
 * cannot silently claim compatibility with an unpinned revision.
 */
export const MCP_TRANSPORT_REVISION = "2026-07-28";

/** Meta-key prefixes. Mirrors the `provider-profile:*` / `install-receipt:*` pattern. */
export const MCP_ENDPOINT_META_PREFIX = "mcp-endpoint:";
export const MCP_TOOL_SNAPSHOT_META_PREFIX = "mcp-tool-snapshot:";

/**
 * One tool's content-addressed descriptor. The runtime does not
 * store the raw description text or schema; only the digests. An
 * audit can replay what was approved at `capturedAt` by reading
 * the snapshot row's `tools[]` (the digests are stored; the
 * source text + schema would need to be re-supplied by the
 * original transport source, which is out of scope for M4.5).
 */
export const mcpToolDescriptorSchema = z
  .object({
    name: z.string().min(1).max(200),
    descriptionDigest: z.string().regex(/^[0-9a-f]{64}$/),
    inputSchemaDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type McpToolDescriptor = z.infer<typeof mcpToolDescriptorSchema>;

export const mcpToolSnapshotSchema = z
  .object({
    endpointId: z.string().uuid(),
    transportRevision: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
    capturedAt: z.string().datetime(),
    tools: z.array(mcpToolDescriptorSchema).max(4096),
    snapshotDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type McpToolSnapshot = z.infer<typeof mcpToolSnapshotSchema>;

/**
 * The identity-row shape stored in `meta` under
 * `mcp-endpoint:<endpointId>`. `approvedSnapshotDigest` is `null`
 * until an authority grant has approved a snapshot — the M4.5
 * line "keep added powers unavailable until authorized".
 */
export interface McpEndpointRow {
  readonly endpointId: string;
  readonly url: string;
  readonly urlHash: string;
  readonly transportRevision: string;
  readonly approvedSnapshotDigest: string | null;
  readonly capturedAt: string;
}

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
 * Derive a deterministic UUID v4 from `(url, transportRevision)`.
 * The UUID format lets the rest of the runtime treat the endpoint
 * id like any other entity id (e.g. in scope references).
 *
 * Same input ⇒ same id; different URLs do not collide; different
 * transport revisions produce different ids so a future transport
 * upgrade does not silently re-bind a previously-revoked endpoint.
 */
export function deriveEndpointId(url: string, transportRevision: string): {
  endpointId: string;
  urlHash: string;
} {
  // Bare SHA-256 of the URL — included in the identity row so an
  // audit can verify the URL has not changed between recaptures.
  const urlHash = createHash("sha256").update(url, "utf8").digest("hex");
  // Identity digest: SHA-256 over `url\ntransportRevision`.
  const digest = createHash("sha256")
    .update(`${url}\n${transportRevision}`, "utf8")
    .digest("hex");
  // UUID v4 formatting (same pattern as
  // `installation-plan.ts:manifestIdFromSeed`).
  const a = digest.slice(0, 8);
  const b = digest.slice(8, 12);
  const c = "4" + digest.slice(13, 16);
  const d = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20);
  const e = digest.slice(20, 32);
  return { endpointId: `${a}-${b}-${c}-${d}-${e}`, urlHash };
}

/** SHA-256 over canonical JSON of the descriptor (text + schema). */
function digestDescriptor(
  description: string,
  inputSchema: unknown,
): { descriptionDigest: string; inputSchemaDigest: string } {
  return {
    descriptionDigest: createHash("sha256").update(description, "utf8").digest("hex"),
    inputSchemaDigest: createHash("sha256").update(stableStringify(inputSchema), "utf8").digest("hex"),
  };
}

/** Build a snapshot from raw tool input, computing all digests deterministically. */
function buildSnapshot(input: {
  endpointId: string;
  transportRevision: string;
  tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
}): McpToolSnapshot {
  const tools: McpToolDescriptor[] = input.tools.map((t) => {
    const { descriptionDigest, inputSchemaDigest } = digestDescriptor(t.description, t.inputSchema);
    return { name: t.name, descriptionDigest, inputSchemaDigest };
  });
  // The snapshot digest intentionally EXCLUDES `capturedAt`.
  // Drift detection is about tool-set equality, not "captured at
  // this exact millisecond". A re-record at a later time with
  // identical tools yields the same digest; the recorded row
  // carries a fresh `capturedAt` so an audit can still replay
  // the capture moment.
  const snapshotDigest = createHash("sha256")
    .update(
      stableStringify({
        endpointId: input.endpointId,
        transportRevision: input.transportRevision,
        tools,
        snapshotDigest: "",
      }),
      "utf8",
    )
    .digest("hex");
  const capturedAt = new Date().toISOString();
  const finalSnapshot: McpToolSnapshot = {
    endpointId: input.endpointId,
    transportRevision: input.transportRevision,
    capturedAt,
    tools,
    snapshotDigest,
  };
  // Sanity-check that the schema accepts the shape. This guards
  // against silent regressions in field names / digests.
  return mcpToolSnapshotSchema.parse(finalSnapshot);
}

/**
 * Record an MCP endpoint discovery result. Writes the snapshot
 * row (content-addressed) and the identity row (one per
 * endpointId; INSERT OR REPLACE so re-recording is idempotent
 * for the identity row).
 *
 * Refuses mismatched `transportRevision` with
 * `AppError("INVALID_REQUEST", …)` — the M4 gate forbids
 * pretending the runtime supports an unpinned revision.
 */
export function recordEndpointDiscovery(
  worker: DbWorker,
  input: {
    url: string;
    transportRevision: string;
    tools: ReadonlyArray<{ name: string; description: string; inputSchema: unknown }>;
  },
): { endpointId: string; snapshot: McpToolSnapshot; snapshotDigest: string } {
  if (input.url.length === 0 || input.url.length > 2048) {
    throw new AppError("INVALID_REQUEST", "MCP endpoint URL must be 1..2048 characters");
  }
  if (input.transportRevision !== MCP_TRANSPORT_REVISION) {
    throw new AppError(
      "INVALID_REQUEST",
      `MCP transport revision "${input.transportRevision}" is not supported (pinned: ${MCP_TRANSPORT_REVISION})`,
    );
  }
  const { endpointId, urlHash } = deriveEndpointId(input.url, input.transportRevision);
  const snapshot = buildSnapshot({ endpointId, transportRevision: input.transportRevision, tools: input.tools });
  const driver = driverOf(worker);

  // Snapshot row (content-addressed). The key embeds the
  // snapshot digest so identical snapshots collapse to a single
  // row on re-record.
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(snapshotKey(endpointId, snapshot.snapshotDigest), JSON.stringify(snapshot));

  // Identity row. Preserve the existing `approvedSnapshotDigest`
  // when one is already recorded — re-discovery must not
  // silently revoke approval.
  const existing = driver.prepare(`SELECT value FROM meta WHERE key = ?`).first(endpointKey(endpointId));
  const capturedAt = new Date().toISOString();
  let approvedSnapshotDigest: string | null = null;
  if (existing) {
    try {
      const parsed: unknown = JSON.parse(String(existing.value ?? ""));
      if (parsed && typeof parsed === "object") {
        const prior = (parsed as { approvedSnapshotDigest?: unknown }).approvedSnapshotDigest;
        if (typeof prior === "string" && /^[0-9a-f]{64}$/.test(prior)) {
          approvedSnapshotDigest = prior;
        }
      }
    } catch {
      // Corrupt prior row — overwrite cleanly.
    }
  }
  const row: McpEndpointRow = {
    endpointId,
    url: input.url,
    urlHash,
    transportRevision: input.transportRevision,
    approvedSnapshotDigest,
    capturedAt,
  };
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(endpointKey(endpointId), JSON.stringify(row));
  return { endpointId, snapshot, snapshotDigest: snapshot.snapshotDigest };
}

/** Read the identity row for an endpoint id. Returns `undefined` when absent. */
export function readEndpointRow(worker: DbWorker, endpointId: string): McpEndpointRow | undefined {
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT value FROM meta WHERE key = ?`).first(endpointKey(endpointId));
  if (!row) return undefined;
  const raw = String(row.value ?? "");
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const p = parsed as Record<string, unknown>;
    if (
      typeof p.endpointId !== "string" ||
      typeof p.url !== "string" ||
      typeof p.urlHash !== "string" ||
      typeof p.transportRevision !== "string" ||
      typeof p.capturedAt !== "string"
    ) {
      return undefined;
    }
    return {
      endpointId: p.endpointId,
      url: p.url,
      urlHash: p.urlHash,
      transportRevision: p.transportRevision,
      approvedSnapshotDigest:
        typeof p.approvedSnapshotDigest === "string" && /^[0-9a-f]{64}$/.test(p.approvedSnapshotDigest)
          ? p.approvedSnapshotDigest
          : null,
      capturedAt: p.capturedAt,
    };
  } catch {
    return undefined;
  }
}

/** List all snapshots recorded for an endpoint, sorted by `capturedAt` ascending. */
export function listEndpointSnapshots(worker: DbWorker, endpointId: string): McpToolSnapshot[] {
  const driver = driverOf(worker);
  // Iterate the meta table client-side (in-memory driver lacks
  // LIKE). The endpoint prefix-scoped scan is cheap because the
  // meta table is small relative to the runtime's main tables.
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const prefix = `${MCP_TOOL_SNAPSHOT_META_PREFIX}${endpointId}:`;
  const out: McpToolSnapshot[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(prefix)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      const parsed = mcpToolSnapshotSchema.parse(JSON.parse(raw));
      out.push(parsed);
    } catch (err) {
      if (!(err instanceof ZodError)) {
        // Skip malformed rows silently — listing must not throw.
      }
    }
  }
  return out.sort((a, b) => (a.capturedAt < b.capturedAt ? -1 : a.capturedAt > b.capturedAt ? 1 : 0));
}

/** Test seam: build the meta key for an endpoint identity row. */
export function endpointKey(endpointId: string): string {
  return `${MCP_ENDPOINT_META_PREFIX}${endpointId}`;
}

/** Test seam: build the meta key for a snapshot row. */
export function snapshotKey(endpointId: string, snapshotDigest: string): string {
  return `${MCP_TOOL_SNAPSHOT_META_PREFIX}${endpointId}:${snapshotDigest}`;
}
