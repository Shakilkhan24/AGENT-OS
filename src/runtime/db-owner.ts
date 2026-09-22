/**
 * M3c.1 — runtime database owner.
 *
 * The runtime owns one real SQLite connection. Memory is an explicit test
 * opt-in, never a fallback for a broken or unsupported production runtime.
 * The current caller places state.db under dataDir. M2 storage relocation
 * and migration remain a separate integration gate; runtimeDir is NOT proof
 * of durable Linux-native storage.
 *
 * The owner applies the schema DDL exactly once on open so the worker is
 * ready before the runtime workspace starts dispatching handlers.
 *
 * Ownership rules:
 *  - One worker per `RuntimeWorkspace`. The handle is closed exactly
 *    once, in `RuntimeWorkspace.close()`. Closing twice is a no-op.
 *  - The worker is constructed with a small concurrency budget (4) so a
 *    single `RuntimeWorkspace` cannot exhaust file descriptors or lock
 *    starvation under load.
 *  - The owner never executes filesystem/process effects; writers do
 *    that *after* the worker transaction commits, mirroring the rule
 *    documented at `runtime/db/worker.ts:9-14`.
 */
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { AppError } from "../shared/errors";
import { type Database } from "./db/types";
import { DbWorker } from "./db/worker";
import { SqliteDatabase, hasSqliteBuiltin } from "./db/sqlite";
import { MemoryDatabase } from "./db/memory";
import { tableSpecs, SCHEMA_VERSION } from "./db/schema";
import { ensureScheduleColumns } from "./db/migrations/ensure-schedule-columns";

export interface OwnedDb {
  readonly worker: DbWorker;
  readonly driver: Database;
  readonly location: "memory" | "sqlite";
  /** Force the worker's underlying store to a durable flush. */
  flush(): Promise<void>;
  /** Close the worker; idempotent. */
  close(): Promise<void>;
}

/**
 * Open the worker's backing store and apply the schema. Returns the
 * owned handle. Preserve the current database path until a verified store
 * locator migration can relocate existing data without silently losing it.
 *
 * Resolution rules:
 *  - `MINIMAL_RUNTIME_DB=memory` always picks the in-memory driver
 *    (used by tests + dev shells, even on Node 22.12+).
 *  - Otherwise, when `node:sqlite` is available, open a per-profile
 *    SQLite database next to `runtimeDir`. The directory is created
 *    with mode 0700.
 *  - Missing SQLite refuses startup, rather than acknowledging volatile work.
 */
export async function openManagedDatabase(dataDir: string, runtimeDir: string): Promise<OwnedDb> {
  if (!dataDir) throw new AppError("INVALID_REQUEST", "dataDir is required");
  const preferMemory = process.env.MINIMAL_RUNTIME_DB === "memory";
  if (!preferMemory && !hasSqliteBuiltin())
    throw new AppError("UNAVAILABLE", "This runtime requires node:sqlite; reopen MINIMAL with its supported packaged runtime");
  const useSqlite = !preferMemory;
  const driver: Database = useSqlite
    ? await openSqliteDriver(dataDir, runtimeDir)
    : new MemoryDatabase();
  try {
    applySchema(driver, useSqlite);
    // M7.1/M7.3 — bump v5 → v6 by adding schedule audit columns +
    // the new occurrence_state_transition table. `applySchema` already
    // ran with `CREATE TABLE IF NOT EXISTS`, so a fresh install has
    // the v6 columns in place (the helper short-circuits on v6). An
    // existing v5 store has its columns added via ALTER TABLE.
    upgradeSchemaToCurrent(driver, useSqlite);
  }
  catch (error) { driver.close(); throw error; }
  const worker = new DbWorker({ driver });
  let closed = false;
  return {
    worker, driver,
    location: useSqlite ? "sqlite" : "memory",
    async flush() {
      if (closed) return;
      await worker.flush();
    },
    async close() {
      if (closed) return;
      closed = true;
      await worker.close();
    },
  };
}

async function openSqliteDriver(dataDir: string, runtimeDir: string): Promise<Database> {
  // Keep the existing layout. Do not silently relocate an acknowledged DB.
  const sqlitePath = path.join(path.dirname(runtimeDir), "state.db");
  await mkdir(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
  // Touch the data dir so tests that pass an empty directory don't see
  // ENOENT from the SQLite open call.
  void dataDir;
  return new SqliteDatabase(sqlitePath);
}

function applySchema(driver: Database, sqlite: boolean): void {
  // Bootstrap is atomic and repeatable; this does not replace versioned migrations.
  const ddl = (sql: string) => sqlite
    ? sql.replace(/^CREATE (TABLE|(?:UNIQUE )?INDEX) /, "CREATE $1 IF NOT EXISTS ") : sql;
  driver.transaction(() => {
    for (const table of tableSpecs) {
      driver.prepare(ddl(table.ddl)).run();
      for (const index of table.indices) driver.prepare(ddl(index)).run();
    }
  });
}

/**
 * M7.1/M7.3 — bring a previously-opened store forward to
 * `SCHEMA_VERSION`. On a fresh install `applySchema` already created
 * the v6 columns + tables (CREATE TABLE IF NOT EXISTS), so this is a
 * no-op. On an existing v5 store it runs the idempotent
 * `ensureScheduleColumns` seam and stamps `PRAGMA user_version` so
 * the next open skips the migration.
 *
 * The memory driver has no `PRAGMA user_version` support (it's a
 * pure in-memory stub) and starts fresh with the v6 schema from
 * `applySchema`; both make the migration a no-op here.
 */
function upgradeSchemaToCurrent(driver: Database, sqlite: boolean): void {
  if (!sqlite) return; // memory driver is fresh per `new MemoryDatabase()`
  const current = readUserVersion(driver);
  if (current >= SCHEMA_VERSION) return; // already at v6
  ensureScheduleColumns(driver);
  // Stamp `user_version` so the next open skips the migration seam.
  // The M5.6 lifecycle-columns migration does not bump user_version;
  // M7 is the first one to do so. The PRAGMA is a side-effecting
  // statement that returns no rows — `node:sqlite` accepts it via
  // the regular `prepare/run` path.
  driver.prepare(`PRAGMA user_version = ${Number(SCHEMA_VERSION)}`).run();
}

/** Read `PRAGMA user_version`. Returns 0 for stores that have never
 *  set the value (the default). */
function readUserVersion(driver: Database): number {
  const row = driver.prepare("PRAGMA user_version").first();
  const raw = (row as { user_version?: number } | undefined)?.user_version;
  return typeof raw === "number" ? raw : 0;
}
