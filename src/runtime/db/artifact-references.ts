/**
 * M3a — `artifact_reference` entity service.
 *
 * An artifact reference is a content-addressed pin of an external resource
 * the task references — a file at a URI with a sha256 digest. The (uri,
 * sha256) pair is unique so two scans of the same resource produce one row.
 *
 * Artifacts carry `expiresAt` so a long-running task can invalidate stale
 * pins on a TTL; the dispatcher refuses to use a reference whose
 * `expiresAt` is in the past.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { artifactReferenceRowSchema } from "./schema";
import { artifactKindSchema, type ArtifactReference } from "../../shared/managed";
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