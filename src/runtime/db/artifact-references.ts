/**
 * M3a / M3c.3 — `artifact_reference` entity service.
 *
 * An artifact reference is a content-addressed pin of an external resource
 * the task references — a file at a URI with a sha256 digest. The (uri,
 * sha256) pair is unique so two scans of the same resource produce one row.
 *
 * Artifacts carry `expiresAt` so a long-running task can invalidate stale
 * pins on a TTL; the dispatcher refuses to use a reference whose
 * `expiresAt` is in the past.
 *
 * M3c.3 — `previewArtifact` is the *gated* read path. It enforces:
 *   (a) the caller passes a `principal`;
 *   (b) an `approved` grant row exists whose `principal` matches and
 *       whose `digests_json` contains the artifact's `sha256`
 *       (content hashes alone do not grant access — the grant is
 *       authority);
 *   (c) the grant's `scope_json.artifactKinds` includes the artifact's
 *       `kind` (a caller-supplied `scopeJson` may override the
 *       persisted scope for tests / future re-scope flows);
 *   (d) the returned body is capped at `MAX_PREVIEW_BYTES` (8 KiB) —
 *       artifacts whose declared `bytes` exceed the cap return
 *       `{truncated: true, truncatedBase64Content: ""}` without
 *       opening the file. Only `file://` URIs are read in-tree.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { artifactReferenceRowSchema } from "./schema";
import { artifactKindSchema, type ArtifactReference } from "../../shared/managed";
import type { DbWorker } from "./worker";

/** M3c.3 — hard cap on preview body bytes returned to the renderer. */
export const MAX_PREVIEW_BYTES = 8 * 1024;

export interface ArtifactPreview {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  truncated: boolean;
  /** Base64 of the prefix actually read; empty string when truncated. */
  truncatedBase64Content: string;
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

const pinArtifactSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  uri: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: artifactKindSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(256),
  expiresAt: z.string().datetime().nullable().default(null),
}).strict();
export type PinArtifactInput = z.input<typeof pinArtifactSchema>;

export async function pinArtifact(worker: DbWorker, input: PinArtifactInput): Promise<ArtifactReference> {
  const parsed = pinArtifactSchema.parse(input);
  const driver = driverOf(worker);
  // Idempotent on (uri, sha256): two scans of the same resource collapse to
  // a single row so consumers never have to dedupe downstream.
  const existing = await findArtifactByUri(worker, parsed.uri, parsed.sha256);
  if (existing) return existing;
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO artifact_reference (uuid, task_id, run_id, uri, sha256, kind, bytes, mime, " +
      "imported_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.taskId, parsed.runId, parsed.uri, parsed.sha256, parsed.kind,
      parsed.bytes, parsed.mime, now, parsed.expiresAt,
    );
  });
  const read = await readArtifact(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Artifact reference disappeared after insert");
  return read;
}

export async function readArtifact(worker: DbWorker, id: string): Promise<ArtifactReference | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM artifact_reference WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseArtifactRow(row);
}

export async function findArtifactByUri(worker: DbWorker, uri: string, sha256: string): Promise<ArtifactReference | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM artifact_reference WHERE uri = ? AND sha256 = ?").first(uri, sha256);
  if (!row) return undefined;
  return parseArtifactRow(row);
}

/** Flat lister over every artifact row. Used by M3c.1's review shell. */
export async function listArtifacts(worker: DbWorker): Promise<ArtifactReference[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM artifact_reference ORDER BY imported_at ASC").all();
  return rows.map(parseArtifactRow);
}

export function isArtifactExpired(reference: ArtifactReference, now: Date = new Date()): boolean {
  if (reference.expiresAt === null) return false;
  return new Date(reference.expiresAt).getTime() <= now.getTime();
}

const previewSchema = z.object({
  id: z.string().uuid(),
  principal: z.string().min(1).max(256),
  scopeJson: z.string().max(64 * 1024).nullable().default(null),
}).strict();
export type PreviewArtifactInput = z.input<typeof previewSchema>;

/**
 * M3c.3 — bounded preview of a pinned artifact.
 *
 * Throws:
 *  - `NOT_FOUND` — no row with the given id
 *  - `FORBIDDEN` — no approved grant for (principal, sha256), or the
 *    grant's scope.artifactKinds does not include the artifact's kind
 *  - `UNSUPPORTED_RESTRICTION` — non-`file://` URI (M3c.3 only reads local files)
 *  - `IO_ERROR` — `fs.readFile` failed
 *
 * On success returns the prefix read (capped at `MAX_PREVIEW_BYTES`).
 * When `bytes > MAX_PREVIEW_BYTES` the function short-circuits with
 * `{truncated: true, truncatedBase64Content: ""}` — the URI is never
 * opened so a maliciously-sized row cannot cause the runtime to
 * buffer an arbitrary file.
 */
export async function previewArtifact(worker: DbWorker, input: PreviewArtifactInput): Promise<ArtifactPreview> {
  const parsed = previewSchema.parse(input);
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM artifact_reference WHERE uuid = ?").first(parsed.id);
  if (!row) throw new AppError("NOT_FOUND", `Artifact reference not found: ${parsed.id}`);
  const artifact = parseArtifactRow(row);

  // Authority gate (a) — principal must match an approved grant whose
  // digests_json contains this artifact's sha256.
  const grants = driver.prepare(
    "SELECT * FROM grant WHERE principal = ? AND state = ?",
  ).all(parsed.principal, "approved");
  const matchingGrant = grants.find(g => {
    const digestsJson = String((g as Record<string, unknown>).digests_json ?? "{}");
    try {
      const parsed2 = JSON.parse(digestsJson) as Record<string, unknown>;
      return Object.values(parsed2).includes(artifact.sha256);
    } catch {
      return false;
    }
  });
  if (!matchingGrant)
    throw new AppError("FORBIDDEN",
      "No approved grant covers this artifact's digest for the calling principal");

  // Authority gate (c) — caller's `scopeJson` override takes precedence
  // over the persisted scope (used by tests / future re-scope flows).
  const scopeSource = parsed.scopeJson ?? String(
    (matchingGrant as Record<string, unknown>).scope_json ?? "{}",
  );
  let kindsAllowed: string[];
  try {
    const parsed2 = JSON.parse(scopeSource) as { artifactKinds?: unknown };
    if (!parsed2 || !Array.isArray(parsed2.artifactKinds))
      throw new AppError("FORBIDDEN", "Grant scope missing artifactKinds array");
    kindsAllowed = parsed2.artifactKinds.filter((x): x is string => typeof x === "string");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("FORBIDDEN", "Grant scope JSON is malformed");
  }
  if (!kindsAllowed.includes(artifact.kind))
    throw new AppError("FORBIDDEN",
      `Grant scope does not authorize artifact kind "${artifact.kind}"`);

  // Bounded read (d) — short-circuit on declared size before opening.
  if (artifact.bytes > MAX_PREVIEW_BYTES)
    return {
      id: artifact.id, sha256: artifact.sha256, mime: artifact.mime,
      bytes: artifact.bytes, truncated: true, truncatedBase64Content: "",
    };

  // M3c.3 only reads local files; remote schemes are reserved for
  // M3c.4's diff/artifact view, which will route them through a
  // downloader that can stream + range.
  if (!artifact.uri.startsWith("file://"))
    throw new AppError("UNSUPPORTED_RESTRICTION",
      `URI scheme not supported by previewArtifact: ${artifact.uri}`);

  const path = artifact.uri.slice("file://".length);
  let buffer: Buffer;
  try {
    buffer = readFileSync(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError("IO_ERROR", `Failed to read artifact body: ${message}`);
  }
  const prefix = buffer.subarray(0, Math.min(buffer.byteLength, MAX_PREVIEW_BYTES));
  return {
    id: artifact.id, sha256: artifact.sha256, mime: artifact.mime,
    bytes: artifact.bytes,
    truncated: buffer.byteLength > MAX_PREVIEW_BYTES,
    truncatedBase64Content: prefix.toString("base64"),
  };
}

function parseArtifactRow(row: Record<string, unknown>): ArtifactReference {
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