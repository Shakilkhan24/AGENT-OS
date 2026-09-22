/**
 * M7.6 — CI/DevOps artifact pin + metadata.
 *
 * The M7.6 spec bullet (FUTURE/IMPLEMENTATION-README.md lines 257-263)
 * requires:
 *
 *   > Add read-only CI failure/log collection + release/deployment-
 *   > plan artifacts first. Then explicitly scoped publication, PR,
 *   > promotion, or saved-plan execution via the same grant/evidence/
 *   > broker path. Bind target, revision, artifact/plan digest,
 *   > workflow/configuration and tool versions inside the privileged
 *   > boundary. Keep credentials outside agent-readable environments
 *   > where mediation is required.
 *
 * `ci` reuses the existing M3a `artifact_reference` table — the
 * idempotent `(uri, sha256)` semantics are exactly what CI
 * artifacts want. The metadata (buildId, commitSha, workflowRunId,
 * planDigest?) lives in a separate `meta` row keyed
 * `ci:<sha256>:metadata` so the Memory driver can range-scan it
 * without a schema migration.
 *
 * Authority: `previewArtifact` already enforces grant scope via
 * `scope_json.artifactKinds`. A grant that lists `"ci"` can preview
 * CI artifacts; a grant that does not, cannot. The IPC surface
 * re-checks the grant scope at dispatch time (defence in depth).
 */
import { z } from "zod";
import type { Database } from "./types";
import {
  findArtifactByUri,
  pinArtifact,
  readArtifact,
  type PinArtifactInput,
} from "./artifact-references";
import { artifactReferenceRowSchema } from "./schema";
import type { ArtifactReference } from "../../shared/managed";
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

export const ciArtifactMetadataSchema = z
  .object({
    buildId: z.string().min(1).max(256).optional(),
    commitSha: z.string().regex(/^[0-9a-f]{7,64}$/).optional(),
    workflowRunId: z.string().min(1).max(256).optional(),
    /** Deployment-plan digest when this artifact backs a plan. */
    planDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type CiArtifactMetadata = z.output<typeof ciArtifactMetadataSchema>;
export type CiArtifactMetadataInput = z.input<typeof ciArtifactMetadataSchema>;

const META_PREFIX = "ci:";
const META_SUFFIX = ":metadata";
const META_KEY_RE = /^ci:([0-9a-f]{64}):metadata$/;

function metaKey(sha256: string): string {
  return `${META_PREFIX}${sha256}${META_SUFFIX}`;
}

/**
 * Pin a CI artifact. Wraps `pinArtifact(..., kind: "ci")` so the
 * idempotent (uri, sha256) semantics are preserved, then writes the
 * supplied metadata to a `meta` row. Two calls with the same digest
 * collapse to one row + one metadata row (later call wins).
 */
export async function pinCiArtifact(
  worker: DbWorker,
  input: PinArtifactInput & { metadata?: CiArtifactMetadataInput },
): Promise<{ artifact: ArtifactReference; metadata: CiArtifactMetadata | null }> {
  // Strip metadata before delegating to the lower-level
  // `pinArtifact` (its schema is `.strict()` and would reject the
  // extra field).
  const { metadata: metaInput, ...rest } = input;
  const artifact = await pinArtifact(worker, { ...rest, kind: "ci" });
  let metadata: CiArtifactMetadata | null = null;
  if (metaInput) {
    metadata = writeCiMetadata(worker, artifact.sha256, metaInput);
  }
  return { artifact, metadata };
}

/** Read the metadata for a CI artifact by sha256. */
export function readCiArtifactMetadata(
  worker: DbWorker,
  sha256: string,
): CiArtifactMetadata | null {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?").first(metaKey(sha256)) as
    | { value: string }
    | undefined;
  if (!row) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value) as unknown; }
  catch { return null; }
  const result = ciArtifactMetadataSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** List every CI artifact (kind: "ci") + their metadata. */
export async function listCiArtifacts(
  worker: DbWorker,
): Promise<Array<{ artifact: ArtifactReference; metadata: CiArtifactMetadata | null }>> {
  const driver = driverOf(worker);
  const rows = driver
    .prepare("SELECT * FROM artifact_reference WHERE kind = ? ORDER BY imported_at DESC")
    .all("ci") as Array<Record<string, unknown>>;
  const out: Array<{ artifact: ArtifactReference; metadata: CiArtifactMetadata | null }> = [];
  for (const row of rows) {
    const artifact = parseArtifactRowLocal(row);
    out.push({ artifact, metadata: readCiArtifactMetadata(worker, artifact.sha256) });
  }
  return out;
}

function writeCiMetadata(
  worker: DbWorker,
  sha256: string,
  metadata: CiArtifactMetadataInput,
): CiArtifactMetadata {
  const parsed = ciArtifactMetadataSchema.parse(metadata);
  const driver = driverOf(worker);
  driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .run(metaKey(sha256), JSON.stringify(parsed));
  return parsed;
}

/**
 * Range-scan variant: list every CI metadata row whose sha256 is
 * in [from, to). Used by tests that want a stable enumeration
 * without going through `listCiArtifacts`.
 */
export function readCiMetadataRowsInRange(
  db: Database,
  fromSha: string,
  toShaExclusive: string,
): Array<{ sha256: string; metadata: CiArtifactMetadata }> {
  const lowerKey = `${META_PREFIX}${fromSha}${META_SUFFIX}`;
  const upperKey = `${META_PREFIX}${toShaExclusive}${META_SUFFIX}`;
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?")
    .all(lowerKey, upperKey) as Array<{ key: string; value: string }>;
  const out: Array<{ sha256: string; metadata: CiArtifactMetadata }> = [];
  for (const row of rows) {
    const match = row.key.match(META_KEY_RE);
    if (!match) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value) as unknown; }
    catch { continue; }
    const result = ciArtifactMetadataSchema.safeParse(parsed);
    if (result.success) out.push({ sha256: match[1], metadata: result.data });
  }
  return out;
}

/** Local row parser — the public `parseArtifactRow` is private to
 *  artifact-references.ts; we re-validate with the same row schema. */
function parseArtifactRowLocal(row: Record<string, unknown>): ArtifactReference {
  const parsed = artifactReferenceRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    uri: String(row.uri),
    sha256: String(row.sha256),
    kind: String(row.kind),
    bytes: Number(row.bytes ?? 0),
    mime: String(row.mime ?? ""),
    importedAt: String(row.imported_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  });
  return { ...parsed, id: parsed.uuid };
}

/**
 * Convenience: re-export the (uri, sha256) lookup + the read
 * function so the IPC surface can dedupe by content without
 * exposing the lower-level artifact module to renderer code.
 */
export { findArtifactByUri, readArtifact };
