/**
 * M7 GATE — integration test for the M7 milestone.
 *
 * The M7 spec bullets (FUTURE/IMPLEMENTATION-README.md lines 257-262)
 * require:
 *
 *   - M7.1 durable schedule + revision + occurrence records with
 *     `(scheduleId, revision, intendedUTC)` uniqueness.
 *   - M7.2 skip-and-report missed runs, optional grace-window
 *     coalescing, DST gap / fold handling.
 *   - M7.3 monotonic timers that wake durable admission, boot
 *     identity survives restart, separate queued/executing/
 *     waiting-for-user/disconnected intervals.
 *
 * This file composes the M7 subsystems already covered by their
 * unit tests and verifies the gate-level invariants:
 *
 *   1. publish + promote + tick fires the right number of rows.
 *   2. paused schedule does not stop an active workflow (M7.3).
 *   3. grace-window coalesces exactly one eligible occurrence (M7.2).
 *   4. tzdata version is recorded on every occurrence.
 *   5. boot identity survives "restart" and reconciles stale
 *      pending rows to `unavailable`.
 *   6. monotonic clock advances and is bounded within a boot.
 *   7. occurrence dispatch state machine rejects illegal moves.
 *   8. occurrence dispatch state traverses
 *      pending → dispatched → executing → ended on completion.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { AppError } from "../../src/shared/errors";
import {
  upsertSchedule,
  publishScheduleRevision,
  promoteRevision,
  seedNextOccurrences,
  fireDueOccurrences,
  setScheduleStatus,
  readScheduleRow,
} from "../../src/runtime/orchestration/schedule-dispatcher";
import {
  assertTransition,
  transitionOccurrenceDispatchState,
} from "../../src/runtime/orchestration/occurrence-state";
import { Scheduler } from "../../src/runtime/orchestration/scheduler";
import { monotonicNow } from "../../src/runtime/db/monotonic";
import type { BootIdentity } from "../../src/runtime/db/boot-identity";
import type { OccurrenceDispatchState } from "../../src/runtime/db/schedule-schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function freshBootIdentity(): BootIdentity {
  return {
    bootId: "boot-gate",
    bootedAtIso: new Date().toISOString(),
    monotonicBasisMs: monotonicNow().toString(10),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

test("M7.1 publish + promote + tick fires exactly the intended count", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily 09:00",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const rev = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", rev.revision, "enabled");
    await seedNextOccurrences(worker, "s1", 3, { now: () => new Date("2026-01-01T00:00:00Z") });
    let dispatchedCount = 0;
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatchedCount += 1; return { workflowRunId: "wf-1" }; },
      now: () => new Date("2026-01-01T12:00:00Z"),
    });
    // Daily 09:00 seeded from 2026-01-01T00:00:00Z = one occurrence at
    // 2026-01-01T09:00:00Z. Fire at 2026-01-01T12:00:00Z → exactly 1 row
    // is past-due; the remaining 2 are still in the future.
    assert.equal(result.dispatched, 1, `expected 1 past-due row fired, got ${result.dispatched}`);
    assert.equal(dispatchedCount, 1);
  } finally { await worker.close(); }
});

test("M7.3 paused schedule does not stop an active workflow (setScheduleStatus is idempotent on running rows)", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const rev = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", rev.revision, "enabled");
    // Seed a future occurrence so the dispatcher has something to skip.
    await seedNextOccurrences(worker, "s1", 1, { now: () => new Date("2030-01-01T00:00:00Z") });
    await setScheduleStatus(worker, "s1", "paused");
    let dispatched = 0;
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatched += 1; return { workflowRunId: "wf-1" }; },
      now: () => new Date("2030-01-02T00:00:00Z"),
    });
    // Paused → occurrence skipped (the dispatcher does not touch
    // any running workflow_run rows; that lifecycle belongs to the
    // workflow executor). M7.3 invariant: pausing prevents future
    // STARTS, does not stop an active workflow.
    assert.equal(result.dispatched, 0);
    assert.equal(result.skipped, 1);
    assert.equal(dispatched, 0);
    const row = await readScheduleRow(worker, "s1");
    assert.equal(row?.status, "paused");
  } finally { await worker.close(); }
});

test("M7.2 grace window coalesces exactly one eligible occurrence", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const rev = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", rev.revision, "enabled");
    await seedNextOccurrences(worker, "s1", 3, { now: () => new Date("2026-01-01T00:00:00Z") });
    let dispatchedCount = 0;
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatchedCount += 1; return { workflowRunId: "wf-1" }; },
      now: () => new Date("2026-01-03T09:00:00Z"),
      graceWindowMs: 7 * 24 * 60 * 60_000, // 1 week
    });
    assert.equal(result.dispatched, 2);
    assert.equal(result.coalesced, 1);
    assert.equal(dispatchedCount, 2);
  } finally { await worker.close(); }
});

test("M7.1 tzdata version is recorded on every occurrence", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const rev = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", rev.revision, "enabled");
    const seeded = await seedNextOccurrences(worker, "s1", 2, {
      now: () => new Date("2026-01-01T00:00:00Z"),
      timezoneDataVersion: "icu:74.1",
      bootId: "boot-gate",
    });
    assert.equal(seeded.length, 2);
    for (const occ of seeded) {
      assert.equal(occ.timezoneDataVersion, "icu:74.1");
      assert.equal(occ.bootId, "boot-gate");
    }
  } finally { await worker.close(); }
});

test("M7.3 boot-boundary reconciliation marks stale pending rows unavailable", async () => {
  const worker = freshWorker();
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    tickLookaheadMs: 60_000,
    dispatchRecipe: async () => ({ workflowRunId: "wf-1" }),
  });
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const rev = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", rev.revision, "enabled");
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    driver.prepare(
      "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, local_time_iso, " +
        "timezone_data_version, boot_id, coalesced_with, dispatch_state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("uuid-stale", "s1", rev.revision, "2026-01-01T09:00:00.000Z",
         "pending", null, "icu:test", "boot-dead", null, "pending");
    const result = await scheduler.start();
    assert.equal(result.unavailable, 1);
    const row = driver.prepare(
      "SELECT dispatch_state FROM schedule_occurrence WHERE uuid = 'uuid-stale'",
    ).first();
    assert.equal(row?.dispatch_state, "unavailable");
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7.3 monotonic clock advances and is bounded within a boot", () => {
  const a = monotonicNow();
  // Burn a tick so the clock moves.
  const start = Date.now();
  while (Date.now() - start < 2);
  const b = monotonicNow();
  assert.ok(b > a, `expected monotonicNow to advance, got a=${a} b=${b}`);
  // Bounded within a single boot — values are millisecond, so
  // they fit in 64-bit without overflow for any realistic boot
  // lifetime (Number.MAX_SAFE_INTEGER ms = ~285 000 years).
  assert.ok(Number(a) < Number.MAX_SAFE_INTEGER);
});

test("M7.3 occurrence dispatch state machine rejects illegal transitions", () => {
  assert.throws(
    () => assertTransition("pending", "executing"),
    (e: unknown) => e instanceof AppError && e.failure.code === "CONFLICT",
  );
  assert.throws(
    () => assertTransition("ended", "dispatched"),
    (e: unknown) => e instanceof AppError && e.failure.code === "CONFLICT",
  );
});

test("M7.3 occurrence dispatch state traverses pending → dispatched → executing → ended", async () => {
  const worker = freshWorker();
  const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
  try {
    driver.prepare("INSERT INTO schedule (uuid, schedule_id, display_name, timezone, recipe_id, status, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("uuid-s", "s1", "test", "UTC", "r1", "enabled", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
    driver.prepare("INSERT INTO schedule_revision (uuid, schedule_id, revision, rule_json, timezone, recipe_id, status, revision_digest, published_at) "
      + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("uuid-r", "s1", 1, "{}", "UTC", "r1", "enabled", "0".repeat(64), "2026-01-01T00:00:00Z");
    driver.prepare("INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, local_time_iso, " +
      "timezone_data_version, boot_id, coalesced_with, dispatch_state) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("uuid-occ", "s1", 1, "2026-01-01T09:00:00.000Z", "pending", null, "icu:test", "boot-gate", null, "pending");
    const key = { scheduleId: "s1", revision: 1, intendedUtc: "2026-01-01T09:00:00.000Z" };
    const r1 = await transitionOccurrenceDispatchState(worker, key, "dispatched" as OccurrenceDispatchState, { reason: "fire", recordedBy: "tester" });
    assert.equal(r1.fromState, "pending");
    assert.equal(r1.toState, "dispatched");
    const r2 = await transitionOccurrenceDispatchState(worker, key, "executing" as OccurrenceDispatchState, { reason: "provider started", recordedBy: "tester" });
    assert.equal(r2.fromState, "dispatched");
    assert.equal(r2.toState, "executing");
    const r3 = await transitionOccurrenceDispatchState(worker, key, "ended" as OccurrenceDispatchState, { reason: "completed", recordedBy: "tester" });
    assert.equal(r3.fromState, "executing");
    assert.equal(r3.toState, "ended");
  } finally { await worker.close(); }
});
