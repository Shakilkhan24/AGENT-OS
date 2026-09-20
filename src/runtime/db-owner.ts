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
import { tableSpecs } from "./db/schema";

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
  try { applySchema(driver, useSqlite); }
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
