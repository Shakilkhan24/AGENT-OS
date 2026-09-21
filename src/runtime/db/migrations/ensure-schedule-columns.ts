/**
 * M7.1/M7.3 — idempotent migration seam for the schedule tables.
 *
 * Bumps the runtime from `SCHEMA_VERSION=5` to `SCHEMA_VERSION=6`. The
 * M7 spec adds five columns to existing schedule tables (one new
 * audit table) so a previously-activated database must be brought
 * forward without losing user-created schedules, revisions, or
 * occurrences.
 *
 * The helper:
 *
 *   1. Inspects `PRAGMA table_info(<table>)` to read the current
 *      column set for each schedule table.
 *   2. Runs `ALTER TABLE … ADD COLUMN … DEFAULT …` for every
 *      missing column. SQLite has supported `ADD COLUMN` with a
 *      constant default since 3.31.0, well below the runtime's
 *      22.12 floor.
 *   3. Creates the new `occurrence_state_transition` table via
 *      `CREATE TABLE IF NOT EXISTS` so a fresh install (where the
 *      table already exists in `tableSpecs`) is a no-op.
 *
 * The helper is **idempotent**: every call inspects the schema
 * before writing, so re-running it after a successful bump is a
 * no-op. The returned report lists every column the call actually
 * added (vs. skipped) so tests can assert exactly which path the
 * upgrade took.
 *
 * Wired into `openManagedDatabase` (see `src/runtime/db-owner.ts`)
 * AFTER `applySchema` runs and BEFORE `PRAGMA user_version` is
 * bumped from 5 → 6. Mirrors the M5.6 `ensureLifecycleColumns`
 * pattern but lives separately because the M7 surface is wider
 * (5 columns across 3 tables + 1 new table) and benefits from
 * being independently testable.
 *
 * The MemoryDatabase driver used by tests does not implement
 * `ALTER TABLE`. Tests start with a v6 schema via `tableSpecs`
 * (because `applySchema` runs `CREATE TABLE IF NOT EXISTS`), so
 * the migration helper is exercised only against a real SQLite
 * driver; the helper refuses to run on the memory driver with a
 * structured `AppError("UNAVAILABLE")`.
 */
import type { Database, Row } from "../types";
import { AppError } from "../../../shared/errors";

/** One column that the helper can add. The `kind` mirrors SQLite's
 *  storage-class vocabulary (TEXT/INTEGER/REAL); defaults are
 *  stringified into the ALTER TABLE statement. */
export interface ScheduleColumnSpec {
  readonly column: string;
  readonly definition: string; // e.g. "TEXT NOT NULL DEFAULT ''"
}

export interface EnsureScheduleColumnsReport {
  /** Columns actually added (ALTER TABLE ran). */
  readonly added: ReadonlyArray<{ table: string; column: string }>;
  /** Columns already present (no-op). */
  readonly skipped: ReadonlyArray<{ table: string; column: string }>;
  /** `true` when `occurrence_state_transition` exists at the end
   *  of the call (whether pre-existing or newly created). */
  readonly transitionTablePresent: boolean;
}

interface RawDriver {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Row | undefined;
    all(...b: unknown[]): Row[];
  };
  /** Migration DDL (`ALTER TABLE …`) does not bind parameters; the
   *  in-memory driver has no multi-statement path. */
  exec?(sql: string): void;
}

function driverOf(db: Database): RawDriver {
  return db as unknown as RawDriver;
}

/** Columns the M7 migration adds. Each entry maps a `table` to its
 *  set of new columns + their ALTER TABLE definitions. The order
 *  matches the schema.ts columns so a reader can grep both files
 *  side-by-side. */
const SCHEDULE_COLUMN_ADDS: ReadonlyArray<{ table: string; columns: ReadonlyArray<ScheduleColumnSpec> }> = [
  {
    table: "schedule",
    columns: [
      { column: "host_id", definition: "TEXT NOT NULL DEFAULT ''" },
      { column: "tzdata_version", definition: "TEXT NOT NULL DEFAULT ''" },
      { column: "boot_id", definition: "TEXT NOT NULL DEFAULT ''" },
    ],
  },
  {
    table: "schedule_revision",
    columns: [
      { column: "host_id", definition: "TEXT NOT NULL DEFAULT ''" },
    ],
  },
  {
    table: "schedule_occurrence",
    columns: [
      { column: "boot_id", definition: "TEXT NOT NULL DEFAULT ''" },
      // coalesced_with is nullable (audit-only; default NULL).
      { column: "coalesced_with", definition: "TEXT" },
      { column: "dispatch_state", definition: "TEXT NOT NULL DEFAULT 'pending'" },
    ],
  },
];

/** DDL for the new audit table. Mirrors the entry in `schema.ts`
 *  (the bootstrap path uses `CREATE TABLE IF NOT EXISTS`). The
 *  helper installs it for v5 → v6 upgrades via the same
 *  `IF NOT EXISTS` form so re-running is a no-op. */
const TRANSITION_TABLE_DDL = `CREATE TABLE IF NOT EXISTS occurrence_state_transition (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT NOT NULL UNIQUE,
  occurrence_uuid TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  monotonic_ms_since_boot INTEGER NOT NULL,
  wall_clock_iso TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  recorded_by TEXT NOT NULL DEFAULT ''
)`;

const TRANSITION_INDICES: ReadonlyArray<string> = [
  "CREATE INDEX IF NOT EXISTS occurrence_state_transition_occurrence_idx ON occurrence_state_transition(occurrence_uuid)",
  "CREATE INDEX IF NOT EXISTS occurrence_state_transition_wall_clock_idx ON occurrence_state_transition(wall_clock_iso)",
];

/**
 * Bring a v5 schedule schema forward to v6. Idempotent: every
 * column presence is re-checked on each call. Throws
 * `AppError("UNAVAILABLE")` when the underlying driver cannot
 * execute `ALTER TABLE` (the in-memory test driver is the only
 * known instance — its tests run against a fresh v6 schema).
 */
export function ensureScheduleColumns(db: Database): EnsureScheduleColumnsReport {
  const raw = driverOf(db);
  if (typeof raw.exec !== "function")
    throw new AppError("UNAVAILABLE",
      "ensureScheduleColumns requires a driver with `exec` (real SQLite); "
      + "the memory driver starts fresh with the v6 schema so no migration is needed");

  const added: Array<{ table: string; column: string }> = [];
  const skipped: Array<{ table: string; column: string }> = [];

  for (const { table, columns } of SCHEDULE_COLUMN_ADDS) {
    const present = readColumnNames(db, table);
    for (const col of columns) {
      if (present.has(col.column)) {
        skipped.push({ table, column: col.column });
        continue;
      }
      // Use `exec` because `ALTER TABLE` does not support
      // bound parameters and the SQLite wrapper exposes `exec`
      // as the multi-statement path.
      raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col.column} ${col.definition}`);
      added.push({ table, column: col.column });
    }
  }

  // Create the new audit table + its indices. `IF NOT EXISTS`
  // makes the call idempotent for fresh-install callers where
  // the table already exists from `applySchema`.
  raw.exec(TRANSITION_TABLE_DDL);
  for (const ddl of TRANSITION_INDICES) raw.exec(ddl);

  return {
    added,
    skipped,
    transitionTablePresent: readTableExists(db, "occurrence_state_transition"),
  };
}

/** Returns the set of column names currently present on `table`. */
function readColumnNames(db: Database, table: string): Set<string> {
  const raw = driverOf(db);
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

/** Returns `true` when `table` exists in the current schema. */
function readTableExists(db: Database, table: string): boolean {
  const raw = driverOf(db);
  const rows = raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'index') AND name = ?",
    )
    .all(table);
  return rows.length > 0;
}
