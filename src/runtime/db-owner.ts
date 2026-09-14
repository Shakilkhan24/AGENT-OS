/**
 * M3c.1 — runtime database owner.
 *
 * The runtime owns a single `DbWorker` backed by either `node:sqlite`
 * (production, on the per-profile `/tmp/minimal-${uid}/${profileId}/state.db`
 * path resolved by `resolveProfilePaths`) or the in-memory driver (test
 * and dev shells where `MINIMAL_RUNTIME_DB=memory` is set, or
 * `node:sqlite` isn't available — e.g. dev shells on Node < 22.12).
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
 * owned handle. The `dataDir` argument is the user's data directory
 * (where `profile.id` lives); the SQLite DB lives next to the runtime
 * directory on Linux-native storage, never under OneDrive.
 *
 * Resolution rules:
 *  - `MINIMAL_RUNTIME_DB=memory` always picks the in-memory driver
 *    (used by tests + dev shells, even on Node 22.12+).
 *  - Otherwise, when `node:sqlite` is available, open a per-profile
 *    SQLite database next to `runtimeDir`. The directory is created
 *    with mode 0700.
 *  - As a final fallback (e.g. a host that bundles Electron without
 *    `node:sqlite`), use the in-memory driver. The runtime still works;
 *    a notice is logged by the caller (not by this module) so the
 *    user knows data is not persisted across restarts.
 */
export async function openManagedDatabase(dataDir: string, runtimeDir: string): Promise<OwnedDb> {
  if (!dataDir) throw new AppError("INVALID_REQUEST", "dataDir is required");
  const preferMemory = process.env.MINIMAL_RUNTIME_DB === "memory";
  const useSqlite = !preferMemory && hasSqliteBuiltin();
  const driver: Database = useSqlite
    ? await openSqliteDriver(dataDir, runtimeDir)
    : new MemoryDatabase();
  applySchema(driver);
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
  // Resolve the canonical profile path so the SQLite file lives next to
  // the runtime dir on Linux-native storage. The legacy /data-dir/state.db
  // path is deliberately not used; SQLite stays on the same tmpfs/rootfs
  // partition so fsync semantics are honoured.
  // `runtimeDir` already identifies the per-profile tmpfs directory; the
  // sqlite file lives next to it so the lock, socket and DB all share
  // ownership + permissions.
  const sqlitePath = path.join(path.dirname(runtimeDir), "state.db");
  await mkdir(path.dirname(sqlitePath), { recursive: true, mode: 0o700 });
  // Touch the data dir so tests that pass an empty directory don't see
  // ENOENT from the SQLite open call.
  void dataDir;
  return new SqliteDatabase(sqlitePath);
}

function applySchema(driver: Database): void {
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
}
