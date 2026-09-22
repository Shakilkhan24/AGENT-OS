/**
 * M7.1/M7.3 — schedule column migration tests.
 *
 * Coverage:
 *   1. `ensureScheduleColumns` adds the v6 columns + the new audit
 *      table when called against a v5-shaped store (ALTER TABLE path).
 *      [requires real SQLite]
 *   2. The same call against an already-v6 store is a no-op (no rows
 *      in `added`, all rows in `skipped`). [requires real SQLite]
 *   3. Re-running on a v6 store is idempotent. [requires real SQLite]
 *   4. The Memory driver (lacks `exec()`) throws AppError("UNAVAILABLE").
 *      [runs in-memory — no SQLite required]
 *   5. `openManagedDatabase` runs the helper automatically for SQLite
 *      stores and stamps `PRAGMA user_version` so the next open skips
 *      the migration. [requires real SQLite]
 *   6. The new audit table + its indices exist after the helper runs.
 *      [requires real SQLite]
 *
 * The SQLite-required cases are skipped when `hasSqliteBuiltin()`
 * returns false (the runtime's documented Node >= 22.12 floor includes
 * `node:sqlite`; the in-process memory driver is a test-only fallback
 * and does not support the multi-statement `exec` path that
 * `ALTER TABLE … ADD COLUMN …` requires).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "../../src/shared/errors";
import { openManagedDatabase } from "../../src/runtime/db-owner";
import { SqliteDatabase, hasSqliteBuiltin } from "../../src/runtime/db/sqlite";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  ensureScheduleColumns,
} from "../../src/runtime/db/migrations/ensure-schedule-columns";

const SQLITE_AVAILABLE = hasSqliteBuiltin();

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

interface DriverExec {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
  exec(sql: string): void;
  close(): void;
}

/** Build a SQLite connection whose v5 schedule DDL is missing the
 *  M7 columns. Recreates the same shape `applySchema` produced before
 *  the schema bump (no host_id/tzdata_version/boot_id/coalesced_with/
 *  dispatch_state columns + no occurrence_state_transition table). */
function buildV5Store(): { db: SqliteDatabase; close(): void } {
  const db = new SqliteDatabase(":memory:");
  try {
    // Create every non-schedule table so the FK targets exist.
    for (const table of tableSpecs) {
      if (table.name === "schedule" || table.name === "schedule_revision" || table.name === "schedule_occurrence") continue;
      db.exec(table.ddl);
      for (const index of table.indices) db.exec(index);
    }
    // v5 schedule tables (no M7 columns, no transition table).
    db.exec("CREATE TABLE schedule ("
      + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
      + "uuid TEXT NOT NULL UNIQUE, "
      + "schedule_id TEXT NOT NULL UNIQUE, "
      + "display_name TEXT NOT NULL, "
      + "timezone TEXT NOT NULL, "
      + "recipe_id TEXT NOT NULL, "
      + "overlap_policy TEXT NOT NULL DEFAULT 'skip', "
      + "grace_window_ms INTEGER NOT NULL DEFAULT 0, "
      + "status TEXT NOT NULL DEFAULT 'enabled', "
      + "created_at TEXT NOT NULL, "
      + "updated_at TEXT NOT NULL)");
    db.exec("CREATE TABLE schedule_revision ("
      + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
      + "uuid TEXT NOT NULL UNIQUE, "
      + "schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE, "
      + "revision INTEGER NOT NULL, "
      + "rule_json TEXT NOT NULL, "
      + "timezone TEXT NOT NULL, "
      + "recipe_id TEXT NOT NULL, "
      + "overlap_policy TEXT NOT NULL DEFAULT 'skip', "
      + "grace_window_ms INTEGER NOT NULL DEFAULT 0, "
      + "status TEXT NOT NULL DEFAULT 'draft', "
      + "revision_digest TEXT NOT NULL, "
      + "published_at TEXT NOT NULL, "
      + "published_by TEXT NOT NULL DEFAULT '')");
    db.exec("CREATE TABLE schedule_occurrence ("
      + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
      + "uuid TEXT NOT NULL UNIQUE, "
      + "schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE, "
      + "revision INTEGER NOT NULL, "
      + "intended_utc TEXT NOT NULL, "
      + "state TEXT NOT NULL DEFAULT 'pending', "
      + "local_time_iso TEXT, "
      + "timezone_data_version TEXT, "
      + "dispatched_at TEXT, "
      + "workflow_run_uuid TEXT)");
    db.exec("PRAGMA user_version = 5");
    return { db, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}

function readColumns(db: DriverExec, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

function readTableExists(db: DriverExec, name: string): boolean {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name = ?")
    .all(name);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Tests — pure-memory checks (always run)                            */
/* ------------------------------------------------------------------ */

test("ensureScheduleColumns: refuses the in-memory test driver with UNAVAILABLE", () => {
  const mem = new MemoryDatabase();
  try {
    assert.throws(
      () => ensureScheduleColumns(mem),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "UNAVAILABLE",
    );
  } finally { mem.close(); }
});

/* ------------------------------------------------------------------ */
/* Tests — require real SQLite (skipped when not available)           */
/* ------------------------------------------------------------------ */

const sqliteRequired = SQLITE_AVAILABLE ? test : test.skip;

sqliteRequired("ensureScheduleColumns: ALTER TABLE path adds the v6 columns to a v5 store", () => {
  const { db, close } = buildV5Store();
  try {
    // Sanity: the v6 columns are absent before the migration.
    assert.equal(readColumns(db, "schedule").includes("host_id"), false);
    assert.equal(readColumns(db, "schedule_revision").includes("host_id"), false);
    assert.equal(readColumns(db, "schedule_occurrence").includes("dispatch_state"), false);
    assert.equal(readTableExists(db, "occurrence_state_transition"), false);

    const report = ensureScheduleColumns(db);

    // Every expected column lands in `added`; nothing was a no-op.
    const addedKeys = report.added.map(a => `${a.table}.${a.column}`);
    assert.ok(addedKeys.includes("schedule.host_id"), `expected schedule.host_id in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule.tzdata_version"), `expected schedule.tzdata_version in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule.boot_id"), `expected schedule.boot_id in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule_revision.host_id"), `expected schedule_revision.host_id in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule_occurrence.boot_id"), `expected schedule_occurrence.boot_id in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule_occurrence.coalesced_with"), `expected schedule_occurrence.coalesced_with in ${addedKeys.join(",")}`);
    assert.ok(addedKeys.includes("schedule_occurrence.dispatch_state"), `expected schedule_occurrence.dispatch_state in ${addedKeys.join(",")}`);
    assert.equal(report.skipped.length, 0);
    assert.equal(report.transitionTablePresent, true);

    // The columns actually landed.
    assert.equal(readColumns(db, "schedule").includes("host_id"), true);
    assert.equal(readColumns(db, "schedule").includes("tzdata_version"), true);
    assert.equal(readColumns(db, "schedule").includes("boot_id"), true);
    assert.equal(readColumns(db, "schedule_revision").includes("host_id"), true);
    assert.equal(readColumns(db, "schedule_occurrence").includes("boot_id"), true);
    assert.equal(readColumns(db, "schedule_occurrence").includes("coalesced_with"), true);
    assert.equal(readColumns(db, "schedule_occurrence").includes("dispatch_state"), true);
    // The new audit table + its indices exist.
    assert.equal(readTableExists(db, "occurrence_state_transition"), true);
    assert.equal(readTableExists(db, "occurrence_state_transition_occurrence_idx"), true);
    assert.equal(readTableExists(db, "occurrence_state_transition_wall_clock_idx"), true);
  } finally { close(); }
});

sqliteRequired("ensureScheduleColumns: re-running on a v6 store is a no-op", () => {
  const { db, close } = buildV5Store();
  try {
    const first = ensureScheduleColumns(db);
    assert.equal(first.added.length, 7, `expected 7 added columns, got ${first.added.length}`);
    assert.equal(first.skipped.length, 0);

    const second = ensureScheduleColumns(db);
    assert.equal(second.added.length, 0, `expected 0 added on re-run, got ${second.added.length}`);
    assert.equal(second.skipped.length, 7, `expected all 7 columns in skipped on re-run, got ${second.skipped.length}`);
    assert.equal(second.transitionTablePresent, true);
  } finally { close(); }
});

sqliteRequired("openManagedDatabase: upgrades a v5 SQLite store to v6 + stamps user_version", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "minimal-schedule-migration-"));
  let owned: Awaited<ReturnType<typeof openManagedDatabase>> | undefined;
  try {
    owned = await openManagedDatabase(dir, path.join(dir, "runtime"));
    assert.equal(owned.location, "sqlite");
    await owned.close();
    owned = undefined;

    // Drop the v6 schedule tables and recreate them in v5 shape,
    // leaving user_version at the default (0).
    const db = new SqliteDatabase(path.join(dir, "state.db"));
    try {
      db.exec("DROP TABLE IF EXISTS schedule_occurrence");
      db.exec("DROP TABLE IF EXISTS schedule_revision");
      db.exec("DROP TABLE IF EXISTS schedule");
      db.exec("DROP TABLE IF EXISTS occurrence_state_transition");
      db.exec("CREATE TABLE schedule ("
        + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "uuid TEXT NOT NULL UNIQUE, "
        + "schedule_id TEXT NOT NULL UNIQUE, "
        + "display_name TEXT NOT NULL, "
        + "timezone TEXT NOT NULL, "
        + "recipe_id TEXT NOT NULL, "
        + "overlap_policy TEXT NOT NULL DEFAULT 'skip', "
        + "grace_window_ms INTEGER NOT NULL DEFAULT 0, "
        + "status TEXT NOT NULL DEFAULT 'enabled', "
        + "created_at TEXT NOT NULL, "
        + "updated_at TEXT NOT NULL)");
      db.exec("CREATE TABLE schedule_revision ("
        + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "uuid TEXT NOT NULL UNIQUE, "
        + "schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE, "
        + "revision INTEGER NOT NULL, "
        + "rule_json TEXT NOT NULL, "
        + "timezone TEXT NOT NULL, "
        + "recipe_id TEXT NOT NULL, "
        + "overlap_policy TEXT NOT NULL DEFAULT 'skip', "
        + "grace_window_ms INTEGER NOT NULL DEFAULT 0, "
        + "status TEXT NOT NULL DEFAULT 'draft', "
        + "revision_digest TEXT NOT NULL, "
        + "published_at TEXT NOT NULL, "
        + "published_by TEXT NOT NULL DEFAULT '')");
      db.exec("CREATE TABLE schedule_occurrence ("
        + "id INTEGER PRIMARY KEY AUTOINCREMENT, "
        + "uuid TEXT NOT NULL UNIQUE, "
        + "schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE, "
        + "revision INTEGER NOT NULL, "
        + "intended_utc TEXT NOT NULL, "
        + "state TEXT NOT NULL DEFAULT 'pending', "
        + "local_time_iso TEXT, "
        + "timezone_data_version TEXT, "
        + "dispatched_at TEXT, "
        + "workflow_run_uuid TEXT)");
      db.exec("PRAGMA user_version = 5");
    } finally { db.close(); }

    // Reopen — openManagedDatabase must run the migration seam.
    owned = await openManagedDatabase(dir, path.join(dir, "runtime"));
    const driver = owned.driver as unknown as DriverExec;
    assert.equal(readColumns(driver, "schedule").includes("host_id"), true,
      "expected openManagedDatabase to add schedule.host_id via the migration seam");
    assert.equal(readColumns(driver, "schedule_revision").includes("host_id"), true);
    assert.equal(readColumns(driver, "schedule_occurrence").includes("dispatch_state"), true);
    assert.equal(readTableExists(driver, "occurrence_state_transition"), true);
    const uv = driver.prepare("PRAGMA user_version").first() as { user_version: number };
    assert.equal(uv.user_version, 6, `expected user_version=6 after upgrade, got ${uv.user_version}`);

    // Reopen again — should be a no-op (no errors).
    await owned.close();
    owned = await openManagedDatabase(dir, path.join(dir, "runtime"));
    const driver2 = owned.driver as unknown as DriverExec;
    const uv2 = driver2.prepare("PRAGMA user_version").first() as { user_version: number };
    assert.equal(uv2.user_version, 6, "reopen must not reset user_version");
  } finally {
    await owned?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
