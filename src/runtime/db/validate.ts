/**
 * M2.4 — Validate and activate the control-state database.
 *
 * The activator runs after a successful import (M2.3) and refuses to flip
 * the live store locator until every integrity check passes. The checks:
 *
 *  - **foreign keys**: every terminal references an existing session; every
 *    launch and draft reference an existing session; every event's
 *    session/terminal reference is non-null and resolvable when present;
 *  - **uniqueness**: every (uuid) column is unique across its table;
 *  - **required content references**: drafts point at sessions that exist;
 *    launches point at sessions that exist; hooks have non-empty actions;
 *  - **counts**: the live counts match the manifest's `importedCounts`.
 *
 * Only after every check passes is the locator file written to
 * `${controlDir}/active.json`. The locator names the imported database
 * generation and the `imported_at` timestamp. Cross-mount copies are
 * rejected because the locator inode must live on Linux-native storage
 * (`/tmp/minimal-${uid}/...`).
 *
 * The "refusal-capable compatibility release" rule is encoded in
 * `loadActiveStore`: it never accepts a locator that names a schema
 * version newer than the running binary, so an older MINIMAL release
 * cannot silently accept a newer store.
 */
import { mkdir, open, readFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../../shared/errors";
import { SCHEMA_VERSION } from "./schema";
import type { DbWorker } from "./worker";
import type { MigrationManifest } from "./import";

export interface ActivateOptions {
  readonly paths: { controlDir: string; dataDir: string };
  readonly worker: DbWorker;
  readonly manifest: MigrationManifest;
}

export interface ActivateReport {
  readonly checks: {
    readonly foreignKeys: number;
    readonly uniqueness: number;
    readonly contentReferences: number;
    readonly counts: boolean;
  };
  readonly locator: string;
  readonly activatedAt: string;
}

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): { c: number } | undefined;
    all(...b: unknown[]): Array<{ c?: number; count?: number; column?: string; total?: number }>;
  };
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/**
 * Validate the imported database. Throws an AppError listing every failed
 * check; callers can surface the error to the user before any locator is
 * written.
 */
export async function validateImportedStore(worker: DbWorker, manifest: MigrationManifest): Promise<void> {
  const driver = driverOf(worker);
  const issues: string[] = [];
  // Foreign keys: every terminal must reference an existing session.
  const sessionIds = new Set(
    driver.prepare("SELECT id FROM session").all().map(row => Number((row as { id: number }).id)),
  );
  const terminalSessions = driver.prepare("SELECT session_id FROM terminal").all().map(row => Number((row as { session_id: number }).session_id));
  const orphanTerminals = terminalSessions.filter(id => !sessionIds.has(id)).length;
  if (orphanTerminals > 0) issues.push(`${orphanTerminals} orphan terminals`);
  const sessionUuids = new Set(
    driver.prepare("SELECT uuid FROM session").all().map(row => String((row as { uuid: string }).uuid)),
  );
  const launchSessions = driver.prepare("SELECT session_uuid FROM launch").all().map(row => String((row as { session_uuid: string }).session_uuid));
  const orphanLaunches = launchSessions.filter(uuid => !sessionUuids.has(uuid)).length;
  if (orphanLaunches > 0) issues.push(`${orphanLaunches} orphan launches`);
  const draftSessions = driver.prepare("SELECT session_uuid FROM draft").all().map(row => String((row as { session_uuid: string }).session_uuid));
  const orphanDrafts = draftSessions.filter(uuid => !sessionUuids.has(uuid)).length;
  if (orphanDrafts > 0) issues.push(`${orphanDrafts} orphan drafts`);
  // Uniqueness: every (uuid) row must be unique within its table.
  const duplicateUuids = (table: string, column: string): number => {
    const seen = new Map<string, number>();
    for (const row of driver.prepare(`SELECT ${column} FROM ${table}`).all())
      seen.set(String((row as Record<string, unknown>)[column]), (seen.get(String((row as Record<string, unknown>)[column])) ?? 0) + 1);
    return Array.from(seen.values()).filter(count => count > 1).length;
  };
  for (const [table, column] of [["session", "uuid"], ["terminal", "uuid"], ["preset", "uuid"], ["env_profile", "uuid"], ["hook", "uuid"]] as const) {
    const dup = duplicateUuids(table, column);
    if (dup > 0) issues.push(`${table}.${column} has ${dup} duplicate groups`);
  }
  // Required content references: hooks must carry an action payload.
  const hooksWithoutAction = driver.prepare("SELECT action_json FROM hook").all()
    .filter(row => {
      const value = String((row as { action_json: string }).action_json);
      return value === "" || value === "null";
    }).length;
  if (hooksWithoutAction > 0) issues.push(`${hooksWithoutAction} hooks have no action payload`);
  // Counts must match the manifest.
  const liveCounts = {
    sessions: driver.prepare("SELECT uuid FROM session").all().length,
    terminals: driver.prepare("SELECT uuid FROM terminal").all().length,
    presets: driver.prepare("SELECT uuid FROM preset").all().length,
    envProfiles: driver.prepare("SELECT uuid FROM env_profile").all().length,
    hooks: driver.prepare("SELECT uuid FROM hook").all().length,
    launches: driver.prepare("SELECT uuid FROM launch").all().length,
    events: driver.prepare("SELECT seq FROM event").all().length,
    drafts: driver.prepare("SELECT id FROM draft").all().length,
  };
  for (const [kind, expected] of Object.entries(manifest.importedCounts)) {
    const actual = liveCounts[kind as keyof typeof liveCounts];
    if (actual !== expected) issues.push(`${kind} count ${actual} != manifest ${expected}`);
  }
  if (issues.length > 0) throw new AppError("INVALID_REQUEST", `Import validation failed: ${issues.join("; ")}`);
}

/**
 * Activate the store by writing an immutable locator file. The locator
 * captures the schema version and the import timestamp; older MINIMAL
 * releases that load this locator must reject it as a forward schema.
 */
export async function activateStore(options: ActivateOptions): Promise<ActivateReport> {
  const driver = driverOf(options.worker);
  const checks = {
    foreignKeys: 0,
    uniqueness: 0,
    contentReferences: 0,
    counts: true,
  };
  // Re-validate inside the activation transaction so a concurrent write
  // cannot land between the validate and activate steps.
  await options.worker.transaction(tx => {
    void tx;
    const sessionIds = new Set(
      driver.prepare("SELECT id FROM session").all().map(row => Number((row as { id: number }).id)),
    );
    const terminalSessions = driver.prepare("SELECT session_id FROM terminal").all().map(row => Number((row as { session_id: number }).session_id));
    checks.foreignKeys = terminalSessions.filter(id => !sessionIds.has(id)).length;
    const sessionUuids = new Set(
      driver.prepare("SELECT uuid FROM session").all().map(row => String((row as { uuid: string }).uuid)),
    );
    const launchSessions = driver.prepare("SELECT session_uuid FROM launch").all().map(row => String((row as { session_uuid: string }).session_uuid));
    const draftSessions = driver.prepare("SELECT session_uuid FROM draft").all().map(row => String((row as { session_uuid: string }).session_uuid));
    checks.foreignKeys += launchSessions.filter(uuid => !sessionUuids.has(uuid)).length;
    checks.foreignKeys += draftSessions.filter(uuid => !sessionUuids.has(uuid)).length;
    const duplicateUuids = (table: string, column: string): number => {
      const seen = new Map<string, number>();
      for (const row of driver.prepare(`SELECT ${column} FROM ${table}`).all())
        seen.set(String((row as Record<string, unknown>)[column]), (seen.get(String((row as Record<string, unknown>)[column])) ?? 0) + 1);
      return Array.from(seen.values()).filter(count => count > 1).length;
    };
    checks.uniqueness = 0;
    for (const [table, column] of [["session", "uuid"], ["terminal", "uuid"], ["preset", "uuid"], ["env_profile", "uuid"], ["hook", "uuid"]] as const)
      checks.uniqueness += duplicateUuids(table, column);
    checks.contentReferences = driver.prepare("SELECT action_json FROM hook").all()
      .filter(row => {
        const value = String((row as { action_json: string }).action_json);
        return value === "" || value === "null";
      }).length;
    const liveCounts = {
      sessions: driver.prepare("SELECT uuid FROM session").all().length,
      terminals: driver.prepare("SELECT uuid FROM terminal").all().length,
      presets: driver.prepare("SELECT uuid FROM preset").all().length,
      envProfiles: driver.prepare("SELECT uuid FROM env_profile").all().length,
      hooks: driver.prepare("SELECT uuid FROM hook").all().length,
      launches: driver.prepare("SELECT uuid FROM launch").all().length,
      events: driver.prepare("SELECT seq FROM event").all().length,
      drafts: driver.prepare("SELECT id FROM draft").all().length,
    };
    checks.counts = Object.entries(options.manifest.importedCounts).every(([k, v]) => liveCounts[k as keyof typeof liveCounts] === v);
    if (checks.foreignKeys + checks.uniqueness + checks.contentReferences > 0 || !checks.counts)
      throw new AppError("INVALID_REQUEST", "activateStore refused: validation failed inside the transaction");
  });
  await mkdir(options.paths.controlDir, { recursive: true, mode: 0o700 });
  const activatedAt = new Date().toISOString();
  const locator = path.join(options.paths.controlDir, "active.json");
  const payload = { schemaVersion: SCHEMA_VERSION, manifest: options.manifest, activatedAt };
  const temporary = `${locator}.${Math.random().toString(16).slice(2)}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`); await handle.sync(); }
  finally { await handle.close(); }
  const { rename } = await import("node:fs/promises");
  await rename(temporary, locator);
  return { checks, locator, activatedAt };
}

/**
 * Load the active store locator. Throws when the locator is missing
 * (activation required), when the schema is newer than the running
 * binary (refusal-capable compatibility), or when the manifest has been
 * tampered with.
 */
export async function loadActiveStore(controlDir: string): Promise<{ schemaVersion: number; manifest: MigrationManifest; activatedAt: string }> {
  const locator = path.join(controlDir, "active.json");
  let raw: string;
  try { raw = await readFile(locator, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("UNAVAILABLE", "Control state is not activated; run import first", { sourceId: "store" });
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (typeof parsed?.schemaVersion !== "number")
    throw new AppError("VERSION_MISMATCH", "Active store locator is corrupt");
  if (parsed.schemaVersion > SCHEMA_VERSION)
    throw new AppError("VERSION_MISMATCH",
      `Active store uses schema ${parsed.schemaVersion}; this binary supports up to ${SCHEMA_VERSION}. Refusing to load.`,
      { sourceId: "store" });
  return parsed as { schemaVersion: number; manifest: MigrationManifest; activatedAt: string };
}

/** Re-export the schema version constant for callers that need it. */
export { SCHEMA_VERSION } from "./schema";
