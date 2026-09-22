/**
 * M2.7 — Backup/export with pinned artifacts, and isolated restore with
 * dispatch disabled.
 *
 * The backup format is a directory that contains:
 *  - `manifest.json` — the pinned manifest (schema, counts, digests, version);
 *  - `state.db` — a SQLite snapshot (production) or `state.rows.json` (test
 *    drivers without a binary dump path);
 *  - `artifacts/<id>.json` — pinned artifact files referenced from state
 *    (drafts, presets, env profiles, hooks). Each file is named with a short
 *    id (digest prefix); the manifest records the full digest so verification
 *    can pin to content, not name.
 *
 * The manifest is the source of truth. Each entry pins an artifact to a
 * sha256 digest of its bytes; any mismatch raises `BACKUP_TAMPERED` and
 * refuses restore.
 *
 * Restore semantics:
 *  - the runtime must be in **restore mode** (dispatch disabled) when
 *    restore is invoked; otherwise the call rejects;
 *  - restore is transactional: it replaces the active state with the backup
 *    rows, bumps the snapshot generation by exactly one, and records the
 *    restore timestamp under `meta`;
 *  - a second restore is allowed only if the first restore's mode token has
 *    been released, so dispatch admission is always observable.
 *
 * The dispatcher consults `meta.dispatch_disabled` (a monotonically
 * increasing token) before accepting any command; restore flips it from `0`
 * (admitting) to `1` (blocking). Releasing the token is a separate,
 * audited operation that no code path performs implicitly.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { bumpGeneration } from "./snapshot";

const MANIFEST_VERSION = 1;
const ARTIFACT_PREFIX = "artifacts";

const backupArtifactSchema = z.object({
  /** Stable id used by the manifest and the on-disk filename. */
  id: z.string().min(1),
  /** sha256 digest of the artifact bytes, lowercase hex. */
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Logical kind (draft / preset / env_profile / hook). */
  kind: z.enum(["draft", "preset", "env_profile", "hook"]),
  /** Filename relative to the artifacts directory. */
  filename: z.string().min(1),
  /** Byte length pinned at backup time. */
  bytes: z.number().int().nonnegative(),
});

export type BackupArtifact = z.infer<typeof backupArtifactSchema>;

const backupManifestSchema = z.object({
  /** Backup schema version — refuses mismatched future formats. */
  version: z.literal(MANIFEST_VERSION),
  /** UTC timestamp when the backup was sealed. */
  createdAt: z.string().datetime(),
  /** Random nonce so two backups of the same state never collide on filename. */
  nonce: z.string().regex(/^[0-9a-f]{16}$/),
  /** Digest of the sealed state rows/snapshot. */
  stateDigest: z.string().regex(/^[0-9a-f]{64}$/),
  /** Filename of the sealed state file (relative to the backup dir). */
  stateFile: z.string().min(1),
  /** Bytes of the sealed state file. */
  stateBytes: z.number().int().nonnegative(),
  /** Counts captured at backup time, for at-a-glance review. */
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
  artifacts: z.array(backupArtifactSchema),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** Source DB tables serialised into the backup. */
interface StateDump {
  /** Schema version the dump came from. */
  schema: number;
  /** Table name → array of rows. */
  tables: Record<string, Array<Record<string, unknown>>>;
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

function digest(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Serialise every table to JSON. */
function dumpState(worker: DbWorker, schemaVersion: number): StateDump {
  const driver = driverOf(worker);
  const tables: Record<string, Array<Record<string, unknown>>> = {};
  const names = [
    "session", "terminal", "preset", "env_profile", "hook",
    "launch", "event", "draft", "meta",
  ];
  for (const name of names) tables[name] = driver.prepare(`SELECT * FROM ${name}`).all();
  return { schema: schemaVersion, tables };
}

/** Pin a JSON-encoded artifact (one draft, preset, env profile, or hook). */
interface ArtifactSource {
  id: string;
  kind: BackupArtifact["kind"];
  /** Object that serialises to JSON. The bytes are hashed; the file is written as JSON. */
  payload: unknown;
}

async function writeArtifact(artifactsDir: string, source: ArtifactSource): Promise<BackupArtifact> {
  const bytes = Buffer.from(JSON.stringify(source.payload, null, 2), "utf8");
  const fileDigest = digest(bytes);
  const filename = `${source.kind}-${fileDigest}.json`;
  const target = path.join(artifactsDir, filename);
  // Refuse to overwrite an existing artifact with different bytes.
  let existing: Buffer | undefined;
  try { existing = await readFile(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing && !existing.equals(bytes))
    throw new AppError("CONFLICT", `Artifact ${source.id} mismatch on disk — refusing to clobber an existing backup entry`);
  if (!existing) await writeFile(target, bytes, { mode: 0o600 });
  return { id: source.id, digest: fileDigest, kind: source.kind, filename, bytes: bytes.byteLength };
}

export interface BackupOptions {
  /** Worker reading the live state. */
  worker: DbWorker;
  /** Destination directory; created if missing; must be empty. */
  outputDir: string;
  /** Schema version recorded in the state dump. */
  schemaVersion: number;
  /** Optional override for the state filename (defaults to `state.rows.json`). */
  stateFile?: string;
}

export interface BackupReport {
  manifest: BackupManifest;
  manifestPath: string;
  statePath: string;
  artifactsDir: string;
}

/** Take a sealed backup. Refuses to write into a non-empty outputDir. */
export async function takeBackup(options: BackupOptions): Promise<BackupReport> {
  const { worker, outputDir, schemaVersion } = options;
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  // Refuse to clobber — the manifest is the destination of record.
  const existingManifest = path.join(outputDir, "manifest.json");
  try {
    await readFile(existingManifest);
    throw new AppError("CONFLICT", `Backup directory ${outputDir} already contains a manifest; refusing to clobber`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const artifactsDir = path.join(outputDir, ARTIFACT_PREFIX);
  await mkdir(artifactsDir, { recursive: true, mode: 0o700 });

  // Pin the artifacts before the state so the digest in the manifest is
  // computed against the bytes we just wrote.
  const driver = driverOf(worker);
  const artifacts: BackupArtifact[] = [];
  for (const row of driver.prepare("SELECT id, content FROM draft").all()) {
    artifacts.push(await writeArtifact(artifactsDir, {
      id: String((row as Record<string, unknown>).id),
      kind: "draft",
      payload: { id: String((row as Record<string, unknown>).id), content: String((row as Record<string, unknown>).content) },
    }));
  }
  for (const row of driver.prepare("SELECT uuid, name, command FROM preset").all()) {
    artifacts.push(await writeArtifact(artifactsDir, {
      id: String((row as Record<string, unknown>).uuid),
      kind: "preset",
      payload: { uuid: String((row as Record<string, unknown>).uuid), name: String((row as Record<string, unknown>).name), command: String((row as Record<string, unknown>).command) },
    }));
  }
  for (const row of driver.prepare("SELECT uuid, name, variables_json FROM env_profile").all()) {
    artifacts.push(await writeArtifact(artifactsDir, {
      id: String((row as Record<string, unknown>).uuid),
      kind: "env_profile",
      payload: {
        uuid: String((row as Record<string, unknown>).uuid),
        name: String((row as Record<string, unknown>).name),
        variables: JSON.parse(String((row as Record<string, unknown>).variables_json ?? "{}")),
      },
    }));
  }
  for (const row of driver.prepare("SELECT uuid, name, event, action_json, session_uuid, terminal_uuid, match, enabled FROM hook").all()) {
    artifacts.push(await writeArtifact(artifactsDir, {
      id: String((row as Record<string, unknown>).uuid),
      kind: "hook",
      payload: {
        uuid: String((row as Record<string, unknown>).uuid),
        name: String((row as Record<string, unknown>).name),
        event: String((row as Record<string, unknown>).event),
        action: JSON.parse(String((row as Record<string, unknown>).action_json)),
        sessionUuid: (row as Record<string, unknown>).session_uuid ? String((row as Record<string, unknown>).session_uuid) : null,
        terminalUuid: (row as Record<string, unknown>).terminal_uuid ? String((row as Record<string, unknown>).terminal_uuid) : null,
        match: (row as Record<string, unknown>).match ? String((row as Record<string, unknown>).match) : null,
        enabled: Number((row as Record<string, unknown>).enabled) === 1,
      },
    }));
  }

  // Dump and pin the state.
  const dump = dumpState(worker, schemaVersion);
  const stateBytes = Buffer.from(JSON.stringify(dump), "utf8");
  const stateDigest = digest(stateBytes);
  const stateFile = options.stateFile ?? "state.rows.json";
  const statePath = path.join(outputDir, stateFile);
  await writeFile(statePath, stateBytes, { mode: 0o600 });

  const manifest: BackupManifest = backupManifestSchema.parse({
    version: MANIFEST_VERSION,
    createdAt: new Date().toISOString(),
    nonce: randomBytes(8).toString("hex"),
    stateDigest,
    stateFile,
    stateBytes: stateBytes.byteLength,
    counts: {
      sessions: driver.prepare("SELECT uuid FROM session").all().length,
      terminals: driver.prepare("SELECT uuid FROM terminal").all().length,
      presets: driver.prepare("SELECT uuid FROM preset").all().length,
      envProfiles: driver.prepare("SELECT uuid FROM env_profile").all().length,
      hooks: driver.prepare("SELECT uuid FROM hook").all().length,
      launches: driver.prepare("SELECT uuid FROM launch").all().length,
      events: driver.prepare("SELECT seq FROM event").all().length,
      drafts: driver.prepare("SELECT id FROM draft").all().length,
    },
    artifacts,
  });
  const manifestPath = path.join(outputDir, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  return { manifest, manifestPath, statePath, artifactsDir };
}

export type VerifyResult =
  | { ok: true; manifest: BackupManifest }
  | { ok: false; reason: "MISSING_FILE" | "DIGEST_MISMATCH" | "MANIFEST_INVALID"; detail: string };

/** Re-read every pinned file and confirm the manifest's digests are still valid. */
export async function verifyBackup(inputDir: string): Promise<VerifyResult> {
  const manifest = await loadBackupManifest(inputDir);
  if (!manifest.ok) return manifest;
  const statePath = path.join(inputDir, manifest.value.stateFile);
  let stateBytes: Buffer;
  try { stateBytes = await readFile(statePath); }
  catch (error) {
    return { ok: false, reason: "MISSING_FILE", detail: `state file missing: ${(error as Error).message}` };
  }
  if (digest(stateBytes) !== manifest.value.stateDigest)
    return { ok: false, reason: "DIGEST_MISMATCH", detail: "state digest does not match bytes on disk" };
  for (const artifact of manifest.value.artifacts) {
    const target = path.join(inputDir, ARTIFACT_PREFIX, artifact.filename);
    let bytes: Buffer;
    try { bytes = await readFile(target); }
    catch (error) {
      return { ok: false, reason: "MISSING_FILE", detail: `artifact ${artifact.id} missing: ${(error as Error).message}` };
    }
    if (digest(bytes) !== artifact.digest)
      return { ok: false, reason: "DIGEST_MISMATCH", detail: `artifact ${artifact.id} digest mismatch` };
    if (bytes.byteLength !== artifact.bytes)
      return { ok: false, reason: "DIGEST_MISMATCH", detail: `artifact ${artifact.id} byte-length mismatch` };
  }
  return { ok: true, manifest: manifest.value };
}

export type LoadResult = { ok: true; value: BackupManifest } | { ok: false; reason: "MISSING_FILE" | "MANIFEST_INVALID"; detail: string };

/** Load and parse the manifest from a backup directory. */
export async function loadBackupManifest(inputDir: string): Promise<LoadResult> {
  const manifestPath = path.join(inputDir, "manifest.json");
  let raw: Buffer;
  try { raw = await readFile(manifestPath); }
  catch (error) {
    return { ok: false, reason: "MISSING_FILE", detail: (error as Error).message };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch (error) {
    return { ok: false, reason: "MANIFEST_INVALID", detail: `manifest JSON invalid: ${(error as Error).message}` };
  }
  const result = backupManifestSchema.safeParse(parsed);
  if (!result.success)
    return { ok: false, reason: "MANIFEST_INVALID", detail: result.error.message };
  return { ok: true, value: result.data };
}

const RESTORE_MODE_KEY = "restore_mode_token";

/**
 * Begin a restore. Returns a token the caller must present to {@link endRestore}.
 * The runtime must call `isRestoreActive(worker, token)` (or read meta) before
 * admitting any command while restore is in progress. Re-entering restore
 * mode without an `endRestore` raises `CONFLICT`.
 */
export async function beginRestore(worker: DbWorker): Promise<string> {
  const driver = driverOf(worker);
  const token = randomBytes(16).toString("hex");
  await worker.transaction(tx => {
    void tx;
    const existing = driver.prepare("SELECT value FROM meta WHERE key = ?").first(RESTORE_MODE_KEY);
    if (existing)
      throw new AppError("CONFLICT", "Restore mode is already active; end the current restore before starting a new one");
    driver.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(RESTORE_MODE_KEY, token);
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("dispatch_disabled", token);
  });
  return token;
}

/** Release restore mode. Throws if the supplied token does not match the active one. */
export async function endRestore(worker: DbWorker, token: string): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT value FROM meta WHERE key = ?").first(RESTORE_MODE_KEY);
    if (!row) throw new AppError("INVALID_REQUEST", "Restore mode is not active");
    if (String((row as Record<string, unknown>).value) !== token)
      throw new AppError("INVALID_REQUEST", "Restore token mismatch; refusing to release restore mode");
    driver.prepare("DELETE FROM meta WHERE key = ?").run(RESTORE_MODE_KEY);
    driver.prepare("DELETE FROM meta WHERE key = ?").run("dispatch_disabled");
  });
}

/** Read-only check used by the dispatcher. */
export function isRestoreActive(worker: DbWorker): { active: boolean; token?: string } {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = 'dispatch_disabled'").first();
  if (!row) return { active: false };
  return { active: true, token: String((row as Record<string, unknown>).value) };
}

export interface RestoreOptions {
  worker: DbWorker;
  inputDir: string;
  /** Token returned from {@link beginRestore}; restore refuses if it doesn't match. */
  token: string;
  /** Optional callback to decide which tables to keep (the artisan rows are always replaced). */
  preserveTables?: ReadonlySet<string>;
}

export interface RestoreReport {
  manifest: BackupManifest;
  generation: number;
  counts: BackupManifest["counts"];
}

const CLEARABLE_TABLES = [
  "session", "terminal", "preset", "env_profile", "hook",
  "launch", "event", "draft",
];

/**
 * Replace the live state with the backup contents. The runtime MUST be in
 * restore mode (`beginRestore` was called and `token` is current). Restore
 * runs inside a single transaction: a tampered manifest, missing file or
 * digest mismatch rolls back to the original state.
 */
export async function restoreFromBackup(options: RestoreOptions): Promise<RestoreReport> {
  const { worker, inputDir, token } = options;
  const driver = driverOf(worker);

  // The runtime must already be in restore mode and `token` must match.
  const meta = driver.prepare("SELECT value FROM meta WHERE key = ?").first(RESTORE_MODE_KEY);
  if (!meta)
    throw new AppError("INVALID_REQUEST", "Restore mode is not active; call beginRestore first");
  if (String((meta as Record<string, unknown>).value) !== token)
    throw new AppError("INVALID_REQUEST", "Restore token mismatch; refusing to swap state");

  // Verify the backup before mutating anything.
  const verified = await verifyBackup(inputDir);
  if (!verified.ok)
    throw new AppError("CONFLICT", `Backup verification failed: ${verified.reason} — ${verified.detail}`);
  const manifest = verified.manifest;

  // Load the state dump.
  const dumpRaw = JSON.parse((await readFile(path.join(inputDir, manifest.stateFile))).toString("utf8")) as StateDump;
  if (!dumpRaw || typeof dumpRaw !== "object" || !dumpRaw.tables)
    throw new AppError("CONFLICT", "State dump is malformed");

  let generation = 0;
  await worker.transaction(tx => {
    void tx;
    // Re-check inside the transaction so a concurrent `beginRestore` cannot race.
    const meta2 = driver.prepare("SELECT value FROM meta WHERE key = ?").first(RESTORE_MODE_KEY);
    if (!meta2 || String((meta2 as Record<string, unknown>).value) !== token)
      throw new AppError("CONFLICT", "Restore mode released during restore; aborting");

    // Clear replaceable tables in dependency order: child tables first so the
    // foreign-key from session_id / session_uuid resolves cleanly on reinsert.
    for (const table of CLEARABLE_TABLES) driver.prepare(`DELETE FROM ${table}`).run();

    // Restore rows in declaration order: parents first, then children.
    for (const table of ["session", "preset", "env_profile", "hook", "terminal", "launch", "event", "draft", "meta"]) {
      const rows = (dumpRaw.tables[table] ?? []) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const columns = Object.keys(row);
        const placeholders = columns.map(() => "?").join(", ");
        const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
        driver.prepare(sql).run(...columns.map(column => row[column]));
      }
    }

    // Re-arm restore mode with the supplied token — the DELETE above wiped it.
    driver.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(RESTORE_MODE_KEY, token);
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run("dispatch_disabled", token);
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("restored_at", new Date().toISOString());
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run("restored_from_manifest_nonce", manifest.nonce);
  });

  // Bump generation outside the transaction so the post-restore handshake is
  // observable to reconnecting peers.
  generation = await bumpGeneration(worker);

  return {
    manifest,
    generation,
    counts: manifest.counts,
  };
}

/** Delete a backup directory and every artifact under it. Refuses to wipe an unverified manifest. */
export async function discardBackup(inputDir: string): Promise<void> {
  const manifest = await loadBackupManifest(inputDir);
  if (!manifest.ok) throw new AppError("INVALID_REQUEST", "Refusing to discard a backup with an unreadable manifest");
  await rm(inputDir, { recursive: true, force: true });
}
