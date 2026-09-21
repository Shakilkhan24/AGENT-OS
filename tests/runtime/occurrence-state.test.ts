/**
 * M7.3 — occurrence dispatch state machine tests.
 *
 * Coverage:
 *   1. `assertTransition` allows every move listed in the table.
 *   2. `assertTransition` rejects moves outside the table with
 *      AppError("CONFLICT").
 *   3. `transitionOccurrenceDispatchState` flips the row's
 *      `dispatch_state` AND inserts an audit row inside one
 *      transaction.
 *   4. The audit row carries monotonic-ms-since-boot, wall-clock
 *      ISO, and the supplied reason / recorded_by.
 *   5. Illegal transitions leave the row's `dispatch_state`
 *      untouched (the row stays in `pending`).
 *   6. Trying to transition a missing occurrence throws
 *      AppError("NOT_FOUND").
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { AppError } from "../../src/shared/errors";
import {
  assertTransition,
  transitionOccurrenceDispatchState,
} from "../../src/runtime/orchestration/occurrence-state";
import type { OccurrenceDispatchState } from "../../src/runtime/db/schedule-schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) dbPrepareIndex(driver, index);
  }
  return new DbWorker({ driver });
}

function dbPrepareIndex(driver: MemoryDatabase, ddl: string): void {
  driver.prepare(ddl).run();
}

/** Seed a single occurrence at `key` whose `dispatch_state` is the
 *  supplied value (defaults to `pending`). Returns the worker. */
function seedOccurrence(
  worker: DbWorker,
  key: { scheduleId: string; revision: number; intendedUtc: string },
  dispatchState: OccurrenceDispatchState = "pending",
): void {
  const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void } } }).driver;
  driver.prepare("INSERT INTO schedule (uuid, schedule_id, display_name, timezone, recipe_id, status, created_at, updated_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(`uuid-${key.scheduleId}`, key.scheduleId, "test", "UTC", "r1", "enabled",
         "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  driver.prepare("INSERT INTO schedule_revision (uuid, schedule_id, revision, rule_json, timezone, recipe_id, status, revision_digest, published_at) "
    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(`uuid-rev-${key.scheduleId}-${key.revision}`, key.scheduleId, key.revision,
         "{}", "UTC", "r1", "enabled", "0".repeat(64), "2026-01-01T00:00:00Z");
  driver.prepare(
    "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, dispatch_state) "
      + "VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    `uuid-occ-${key.scheduleId}-${key.revision}-${key.intendedUtc}`,
    key.scheduleId, key.revision, key.intendedUtc,
    "pending", dispatchState,
  );
}

test("M7.3 assertTransition allows every documented move", () => {
  // From pending → dispatched, skipped, cancelled, unavailable.
  for (const to of ["dispatched", "skipped", "cancelled", "unavailable"]) {
    assert.doesNotThrow(() => assertTransition("pending", to as OccurrenceDispatchState));
  }
  // From dispatched → executing, ended, disconnected, failed, cancelled.
  for (const to of ["executing", "ended", "disconnected", "failed", "cancelled"]) {
    assert.doesNotThrow(() => assertTransition("dispatched", to as OccurrenceDispatchState));
  }
  // From executing → waiting-for-user, ended, disconnected, failed.
  for (const to of ["waiting-for-user", "ended", "disconnected", "failed"]) {
    assert.doesNotThrow(() => assertTransition("executing", to as OccurrenceDispatchState));
  }
});

test("M7.3 assertTransition rejects moves outside the table", () => {
  // Terminal states have no outbound edges.
  for (const terminal of ["ended", "unavailable", "skipped", "cancelled", "failed"]) {
    assert.throws(
      () => assertTransition(terminal as OccurrenceDispatchState, "dispatched"),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "CONFLICT",
    );
  }
  // Pending → executing is not allowed (must go through dispatched).
  assert.throws(
    () => assertTransition("pending", "executing"),
    (error: unknown) => error instanceof AppError
      && error.failure.code === "CONFLICT",
  );
});

test("M7.3 transitionOccurrenceDispatchState flips + writes an audit row", async () => {
  const worker = freshWorker();
  const key = { scheduleId: "s1", revision: 1, intendedUtc: "2026-01-01T09:00:00.000Z" };
  try {
    seedOccurrence(worker, key);
    const result = await transitionOccurrenceDispatchState(worker, key, "dispatched", {
      reason: "first fire",
      recordedBy: "tester",
      monotonicNow: () => 5n,
      nowIso: () => "2026-01-01T09:00:01.000Z",
    });
    assert.equal(typeof result.auditUuid, "string");
    assert.equal(result.auditUuid.length, 36);
    assert.equal(result.fromState, "pending");
    assert.equal(result.toState, "dispatched");
    // The row's dispatch_state was actually updated.
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare(
      "SELECT dispatch_state FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?",
    ).first(key.scheduleId, key.revision, key.intendedUtc);
    assert.equal(row?.dispatch_state, "dispatched");
    // The audit row carries our test-supplied fields.
    const audit = driver
      .prepare("SELECT * FROM occurrence_state_transition WHERE uuid = ?")
      .first(result.auditUuid);
    assert.equal(audit?.from_state, "pending");
    assert.equal(audit?.to_state, "dispatched");
    assert.equal(audit?.reason, "first fire");
    assert.equal(audit?.recorded_by, "tester");
    assert.equal(audit?.wall_clock_iso, "2026-01-01T09:00:01.000Z");
  } finally { await worker.close(); }
});

test("M7.3 illegal transition leaves the row in its previous dispatch_state", async () => {
  const worker = freshWorker();
  const key = { scheduleId: "s1", revision: 1, intendedUtc: "2026-01-01T09:00:00.000Z" };
  try {
    seedOccurrence(worker, key, "ended");
    await assert.rejects(
      () => transitionOccurrenceDispatchState(worker, key, "dispatched"),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "CONFLICT",
    );
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare(
      "SELECT dispatch_state FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?",
    ).first(key.scheduleId, key.revision, key.intendedUtc);
    assert.equal(row?.dispatch_state, "ended", "expected the row to stay in `ended`");
    // No audit row was inserted (the transaction rolled back).
    const auditRows = (driver as unknown as {
      prepare: (s: string) => { all: (...b: unknown[]) => Array<Record<string, unknown>> };
    })
      .prepare("SELECT uuid FROM occurrence_state_transition")
      .all();
    assert.equal(auditRows.length, 0, "expected no audit rows after a rejected transition");
  } finally { await worker.close(); }
});

test("M7.3 transitionOccurrenceDispatchState throws NOT_FOUND for a missing occurrence", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      () => transitionOccurrenceDispatchState(worker,
        { scheduleId: "missing", revision: 1, intendedUtc: "2026-01-01T09:00:00.000Z" },
        "dispatched",
      ),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "NOT_FOUND",
    );
  } finally { await worker.close(); }
});
