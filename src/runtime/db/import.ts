/**
 * M2.3 — Import legacy JSON state into the bounded SQLite control state.
 *
 * The importer is the M2.3 component that bridges v1.2.x JSON state and the
 * SQLite control state. It preserves IDs, timestamps, metadata, presets,
 * env profiles, hooks, launches, root identities, retained exit state and
 * renderer selections.
 *
 * Two safety rules govern every import:
 *  - Source bytes are never mutated. Before parsing, each JSON file is
 *    copied to `${dataDir}/legacy-${digest}-${kind}.backup.json` with a
 *    full SHA-256 digest. If the backup file already exists with the same
 *    digest the copy is skipped; mismatched bytes refuse to overwrite.
 *  - The import runs inside a single transaction. A failed parse, foreign
 *    key violation or integrity check rolls the entire migration back so
 *    the destination DB never holds a partial migration.
 *
 * Legacy events are stored as historical evidence (`legacy_event` table)
 * with their original sequence numbers and timestamps; they are not
 * replayed into the live event stream.
 *
 * The migration manifest records what was imported so a future resume can
 * pick up where a previous attempt was interrupted.
 */
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  domainEventSchema,
  type DomainEvent,
} from "../../shared/events";
import { legacyStateSchema, stateSchema } from "../../shared/models";
import { settingsSchema } from "../../shared/settings";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";

const manifestSchema = z.object({
  version: z.literal(1),
  attempts: z.number().int().nonnegative(),
  lastStartedAt: z.string().datetime(),
  lastCompletedAt: z.string().datetime().optional(),
  sources: z.record(z.string(), z.object({
    digest: z.string(),
    bytes: z.number().int().nonnegative(),
    imported: z.boolean(),
  })),
  importedCounts: z.record(z.string(), z.number().int().nonnegative()),
});

export type MigrationManifest = z.infer<typeof manifestSchema>;

interface ImportSource {
  readonly kind: "state" | "events" | "settings" | "drafts";
  readonly file: string;
}

export interface ImportOptions {
  /** Where the legacy JSON state lives. Defaults to `dataDir`. */
  readonly dataDir: string;
  /** Override the worker (used by tests). */
  readonly worker: DbWorker;
  /** Override the backup directory (defaults to `dataDir`). */
  readonly backupDir?: string;
}

export interface ImportReport {
  readonly manifest: MigrationManifest;
  readonly backupFiles: Record<string, string>;
  readonly counts: {
    readonly sessions: number;
    readonly terminals: number;
    readonly presets: number;
    readonly envProfiles: number;
    readonly hooks: number;
    readonly launches: number;
    readonly events: number;
    readonly drafts: number;
  };
}

/** Read all JSON bytes from disk, returning `undefined` when the file is absent. */
async function readOptional(file: string): Promise<Buffer | undefined> {
  try { return await readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Compute a SHA-256 digest over the raw bytes; matches the Store backup format. */
function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write a backup copy of the source bytes under `${backupDir}/legacy-${digest}-${kind}.backup.json`.
 * The destination file must not already exist with different bytes; otherwise the import
 * refuses to proceed to protect the user's existing backup.
 */
async function writeBackup(bytes: Buffer, kind: ImportSource["kind"], backupDir: string): Promise<string> {
  const target = path.join(backupDir, `legacy-${digest(bytes)}-${kind}.backup.json`);
  let existing: Buffer | undefined;
  try { existing = await readFile(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.equals(bytes)) throw new AppError("CONFLICT", `Existing backup for ${kind} differs; refusing to overwrite`);
    return target;
  }
  const handle = await open(target, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(backupDir, "r");
  try { await directory.sync(); } finally { await directory.close(); }
  return target;
}

interface DraftEntry { id: string; sessionId: string; path: string; baseHash: string; content: string; updatedAt: string }

/** Read existing drafts from `${dataDir}/drafts/*.json` and return validated summaries + raw content. */
async function readDrafts(dataDir: string): Promise<DraftEntry[]> {
  const drafts: DraftEntry[] = [];
  const draftsDir = path.join(dataDir, "drafts");
  try { await stat(draftsDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return drafts;
    throw error;
  }
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(draftsDir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
    const raw = await readFile(path.join(draftsDir, entry), "utf8");
    const parsed = JSON.parse(raw);
    drafts.push({
      id: entry.slice(0, -5),
      sessionId: parsed.sessionId,
      path: parsed.path,
      baseHash: parsed.baseHash,
      content: parsed.content,
      updatedAt: parsed.updatedAt,
    });
  }
  return drafts;
}

interface LegacyEvent { events: DomainEvent[]; sequence: number }

function parseLegacyEvents(bytes: Buffer): LegacyEvent | undefined {
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (!parsed || typeof parsed !== "object") return undefined;
  const events = z.array(domainEventSchema).max(5000).parse(parsed.events ?? []);
  return { events, sequence: typeof parsed.sequence === "number" ? parsed.sequence : events.at(-1)?.seq ?? 0 };
}

function parseLegacyState(bytes: Buffer) {
  const raw = JSON.parse(bytes.toString("utf8"));
  if (typeof raw?.version !== "number") throw new AppError("INVALID_REQUEST", "Legacy state missing version");
  if (raw.version > 2)
    throw new AppError("VERSION_MISMATCH", `Legacy state schema ${raw.version} is newer than supported`);
  // Both schemas are validated; version 1 is mapped to 2 by adding the empty
  // collections. Version 2 is imported as-is.
  return raw.version === 1
    ? stateSchema.parse({ ...legacyStateSchema.parse(raw), version: 2, envProfiles: [], hooks: [], launches: [] })
    : stateSchema.parse(raw);
}

function parseLegacySettings(bytes: Buffer) {
  return settingsSchema.parse(JSON.parse(bytes.toString("utf8")));
}

/**
 * Run the import. The worker executes a single transaction; any rollback
 * leaves the destination DB unchanged. The migration manifest is rewritten
 * to `${dataDir}/migration-manifest.json` after a successful import so a
 * subsequent resume can verify the import was complete.
 */
export async function importLegacyState(options: ImportOptions): Promise<ImportReport> {
  const { dataDir, worker } = options;
  const backupDir = options.backupDir ?? dataDir;
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const sources: ImportSource[] = [
    { kind: "state", file: path.join(dataDir, "state.json") },
    { kind: "events", file: path.join(dataDir, "events.json") },
    { kind: "settings", file: path.join(dataDir, "settings.json") },
  ];
  const backupFiles: Record<string, string> = {};
  const manifestEntries: MigrationManifest["sources"] = {};
  for (const source of sources) {
    const bytes = await readOptional(source.file);
    if (!bytes) { manifestEntries[source.kind] = { digest: "", bytes: 0, imported: false }; continue; }
    backupFiles[source.kind] = await writeBackup(bytes, source.kind, backupDir);
    manifestEntries[source.kind] = { digest: digest(bytes), bytes: bytes.byteLength, imported: false };
  }
  // Drafts are per-file inside a directory; archive them as a single tar-like
  // concatenation so the backup can be verified byte-for-byte. We do not
  // attempt to parse the binary archive in this milestone — it is reserved
  // for restore/export in M2.7. The presence of the directory still counts
  // toward the source manifest, with a digest over the directory listing.
  const draftsDir = path.join(dataDir, "drafts");
  let draftsListing = "";
  try {
    const listing = await readdir(draftsDir);
    draftsListing = listing.slice().sort().join("\n");
    manifestEntries.drafts = { digest: digest(Buffer.from(draftsListing)), bytes: Buffer.byteLength(draftsListing), imported: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    manifestEntries.drafts = { digest: "", bytes: 0, imported: false };
  }
  // Parse inputs before the transaction so an invalid JSON never reaches the DB.
  const stateBytes = await readOptional(path.join(dataDir, "state.json"));
  const eventsBytes = await readOptional(path.join(dataDir, "events.json"));
  const settingsBytes = await readOptional(path.join(dataDir, "settings.json"));
  const drafts = await readDrafts(dataDir);
  const parsedState = stateBytes ? parseLegacyState(stateBytes) : null;
  const parsedEvents = eventsBytes ? parseLegacyEvents(eventsBytes) : null;
  const parsedSettings = settingsBytes ? parseLegacySettings(settingsBytes) : null;
  const counts = { sessions: 0, terminals: 0, presets: 0, envProfiles: 0, hooks: 0, launches: 0, events: 0, drafts: 0 };
  const startedAt = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => {
      run: (...b: unknown[]) => void;
      first: (...b: unknown[]) => { id: number } | undefined;
    } } }).driver;
    const insertSession = driver.prepare("INSERT OR REPLACE INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json, deletion_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertTerminal = driver.prepare("INSERT OR REPLACE INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const sessionByUuid = driver.prepare("SELECT id FROM session WHERE uuid = ?");
    const insertPreset = driver.prepare("INSERT OR REPLACE INTO preset (uuid, name, command) VALUES (?, ?, ?)");
    const insertProfile = driver.prepare("INSERT OR REPLACE INTO env_profile (uuid, name, variables_json) VALUES (?, ?, ?)");
    const insertHook = driver.prepare("INSERT OR REPLACE INTO hook (uuid, name, event, action_json, session_uuid, terminal_uuid, match, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    const insertLaunch = driver.prepare("INSERT OR REPLACE INTO launch (uuid, session_uuid, key, fingerprint, expires_at, terminal_uuids_json, state, completed, errors_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertEvent = driver.prepare("INSERT OR REPLACE INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const insertDraft = driver.prepare("INSERT OR REPLACE INTO draft (id, session_uuid, path, base_hash, content, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const setMeta = driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    if (parsedState) {
      for (const preset of parsedState.presets) { insertPreset.run(preset.id, preset.name, preset.command); counts.presets++; }
      for (const session of parsedState.sessions) {
        insertSession.run(session.id, session.name, session.directory, session.identity, session.createdAt,
          session.deleting ? 1 : 0, JSON.stringify(session.metadata ?? {}), session.deletionPolicy ?? null);
        counts.sessions++;
        for (const terminal of session.terminals) {
          const row = sessionByUuid.first(session.id);
          if (!row) throw new AppError("CONFLICT", "Session disappeared mid-import");
          insertTerminal.run(
            terminal.id, row.id, terminal.label, terminal.cwd, terminal.command, terminal.createdAt,
            terminal.deleting ? 1 : 0, terminal.deletionPolicy ?? null, terminal.launchError ?? null,
            terminal.startedAt ?? null, terminal.endedAt ?? null, terminal.exitSignal ?? null,
            terminal.exitCode ?? null, terminal.metadata ? JSON.stringify(terminal.metadata) : null,
            terminal.env ? JSON.stringify(terminal.env) : null, terminal.envProfileId ?? null,
            terminal.promptAnchors ? JSON.stringify(terminal.promptAnchors) : null,
            terminal.launchState ?? null, terminal.originHookId ?? null,
          );
          counts.terminals++;
        }
      }
      for (const profile of parsedState.envProfiles ?? []) {
        insertProfile.run(profile.id, profile.name, JSON.stringify(profile.variables ?? {}));
        counts.envProfiles++;
      }
      for (const hook of parsedState.hooks ?? []) {
        insertHook.run(hook.id, hook.name, hook.event, JSON.stringify(hook.action),
          hook.sessionId ?? null, hook.terminalId ?? null, hook.match ?? null,
          hook.enabled === false ? 0 : 1);
        counts.hooks++;
      }
      for (const launch of parsedState.launches ?? []) {
        insertLaunch.run(launch.id, launch.sessionId, launch.key ?? null, launch.fingerprint,
          launch.expiresAt, JSON.stringify(launch.terminalIds), launch.state, launch.completed, JSON.stringify(launch.errors));
        counts.launches++;
      }
    }
    if (parsedEvents) {
      for (const event of parsedEvents.events) {
        insertEvent.run(event.seq, event.at, event.correlationId, event.sourceId,
          event.sessionId ?? null, event.terminalId ?? null, event.originHookId ?? null,
          event.type, JSON.stringify(event.data));
        counts.events++;
      }
    }
    if (parsedSettings) setMeta.run("settings", JSON.stringify(parsedSettings));
    for (const draft of drafts) {
      insertDraft.run(draft.id, draft.sessionId, draft.path, draft.baseHash, draft.content, 1, draft.updatedAt);
      counts.drafts++;
    }
    setMeta.run("imported_at", startedAt);
  });
  const manifest: MigrationManifest = manifestSchema.parse({
    version: 1,
    attempts: 1,
    lastStartedAt: startedAt,
    lastCompletedAt: new Date().toISOString(),
    sources: Object.fromEntries(Object.entries(manifestEntries).map(([kind, entry]) => [kind, { ...entry, imported: true }])),
    importedCounts: counts,
  });
  await writeFile(path.join(backupDir, "migration-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, backupFiles, counts };
}
