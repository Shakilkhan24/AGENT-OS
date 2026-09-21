/**
 * M7 — scheduler loop tests.
 *
 * Coverage:
 *   1. `start()` reconciles stale `pending` rows owned by a prior
 *      boot to `dispatch_state = "unavailable"`.
 *   2. `start()` seeds ≥ lookAheadCount future occurrences per
 *      enabled schedule.
 *   3. `tick()` dispatches a due row + reseeds + returns a result
 *      with the next-due timestamp.
 *   4. A mid-tick crash leaves the occurrence `pending` so a
 *      re-tick can retry.
 *   5. `start()` is idempotent — re-calling while running is a
 *      no-op.
 *   6. `stop()` cancels the timer and waits for an in-flight tick.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { Scheduler } from "../../src/runtime/orchestration/scheduler";
import {
  upsertSchedule,
  publishScheduleRevision,
  promoteRevision,
} from "../../src/runtime/orchestration/schedule-dispatcher";
import type { BootIdentity } from "../../src/runtime/db/boot-identity";
import { monotonicNow } from "../../src/runtime/db/monotonic";

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
    bootId: "boot-current",
    bootedAtIso: new Date().toISOString(),
    monotonicBasisMs: monotonicNow().toString(10),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

async function seedEnabledSchedule(worker: DbWorker): Promise<{ scheduleId: string; revision: number }> {
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
  return { scheduleId: "s1", revision: rev.revision };
}

test("M7 scheduler.start reconciles stale pending rows to unavailable", async () => {
  const worker = freshWorker();
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    tickLookaheadMs: 60_000, // long enough that stop() cancels before fire
    dispatchRecipe: async () => ({ workflowRunId: "wf-1" }),
  });
  try {
    const { scheduleId, revision } = await seedEnabledSchedule(worker);
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    // Insert a stale `pending` row owned by a prior boot.
    driver.prepare(
      "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, local_time_iso, " +
        "timezone_data_version, boot_id, coalesced_with, dispatch_state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("uuid-stale", scheduleId, revision, "2026-01-01T09:00:00.000Z",
         "pending", null, "icu:test", "boot-dead", null, "pending");

    const result = await scheduler.start();
    assert.equal(result.unavailable, 1, "expected 1 stale row reconciled");

    const row = driver.prepare(
      "SELECT dispatch_state, boot_id FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?",
    ).first(scheduleId, revision, "2026-01-01T09:00:00.000Z");
    assert.equal(row?.dispatch_state, "unavailable");
    assert.equal(row?.boot_id, "boot-dead", "boot_id should not be overwritten by the reconciliation");
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7 scheduler.start seeds future occurrences per enabled schedule", async () => {
  const worker = freshWorker();
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    lookAheadCount: 5,
    tickLookaheadMs: 60_000,
    dispatchRecipe: async () => ({ workflowRunId: "wf-1" }),
  });
  try {
    await seedEnabledSchedule(worker);
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { all: (...b: unknown[]) => Array<Record<string, unknown>> } } }).driver;

    const result = await scheduler.start();
    assert.ok(result.seeded >= 5, `expected ≥5 seeded, got ${result.seeded}`);

    const rows = driver.prepare(
      "SELECT intended_utc FROM schedule_occurrence WHERE schedule_id = ? AND state = 'pending' ORDER BY intended_utc ASC",
    ).all("s1");
    assert.ok(rows.length >= 5, `expected ≥5 pending rows, got ${rows.length}`);
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7 scheduler.tick dispatches due rows and returns next-due timestamp", async () => {
  const worker = freshWorker();
  let dispatchedCount = 0;
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    tickLookaheadMs: 60_000,
    dispatchRecipe: async () => {
      dispatchedCount += 1;
      return { workflowRunId: "wf-1" };
    },
    now: () => new Date("2026-01-05T00:00:00Z"),
  });
  try {
    const { scheduleId, revision } = await seedEnabledSchedule(worker);
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    // Insert a past-due occurrence directly so the tick fires it.
    driver.prepare(
      "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, local_time_iso, " +
        "timezone_data_version, boot_id, coalesced_with, dispatch_state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("uuid-due", scheduleId, revision, "2026-01-01T09:00:00.000Z",
         "pending", null, "icu:test", "boot-current", null, "pending");

    await scheduler.start();
    const tick = await scheduler.tick();
    assert.equal(tick.dispatched, 1, `expected 1 row fired, got ${tick.dispatched}`);
    assert.equal(dispatchedCount, 1);
    assert.ok(tick.nextIntendedUtc, "expected nextIntendedUtc to be set after reseed");
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7 scheduler.tick mid-crash leaves the occurrence pending for retry", async () => {
  const worker = freshWorker();
  let shouldThrow = true;
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    tickLookaheadMs: 60_000,
    dispatchRecipe: async () => {
      if (shouldThrow) {
        shouldThrow = false;
        throw new Error("simulated provider crash");
      }
      return { workflowRunId: "wf-1" };
    },
    now: () => new Date("2026-01-05T00:00:00Z"),
  });
  try {
    const { scheduleId, revision } = await seedEnabledSchedule(worker);
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    driver.prepare(
      "INSERT INTO schedule_occurrence (uuid, schedule_id, revision, intended_utc, state, local_time_iso, " +
        "timezone_data_version, boot_id, coalesced_with, dispatch_state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run("uuid-due", scheduleId, revision, "2026-01-01T09:00:00.000Z",
         "pending", null, "icu:test", "boot-current", null, "pending");

    await scheduler.start();
    // First tick: provider throws — row stays pending.
    await assert.rejects(() => scheduler.tick(), (e: unknown) => e instanceof Error && /simulated/.test(e.message));
    const rowAfter = driver.prepare(
      "SELECT state, workflow_run_uuid FROM schedule_occurrence WHERE schedule_id = ? AND revision = ? AND intended_utc = ?",
    ).first(scheduleId, revision, "2026-01-01T09:00:00.000Z");
    // The dispatcher's UPDATE is gated by `state = 'pending'`, so a
    // throwing provider leaves the row untouched.
    assert.equal(rowAfter?.state, "pending", "row should remain pending when dispatch throws");
    assert.equal(rowAfter?.workflow_run_uuid, undefined);
    // Second tick succeeds.
    const result = await scheduler.tick();
    assert.equal(result.dispatched, 1);
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7 scheduler.start is idempotent while running", async () => {
  const worker = freshWorker();
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    lookAheadCount: 3,
    tickLookaheadMs: 60_000,
    dispatchRecipe: async () => ({ workflowRunId: "wf-1" }),
  });
  try {
    await seedEnabledSchedule(worker);
    const r1 = await scheduler.start();
    const r2 = await scheduler.start();
    assert.deepEqual(r2, { dispatched: 0, skipped: 0, coalesced: 0, unavailable: 0, seeded: 0, nextIntendedUtc: null });
    assert.ok(r1.seeded >= 3);
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});

test("M7 scheduler.stop cancels the timer and waits for in-flight tick", async () => {
  const worker = freshWorker();
  const scheduler = new Scheduler(worker, {
    bootIdentity: freshBootIdentity(),
    tickLookaheadMs: 50,
    dispatchRecipe: async () => ({ workflowRunId: "wf-1" }),
  });
  try {
    await seedEnabledSchedule(worker);
    await scheduler.start();
    // Trigger a tick then immediately stop — stop must wait for it.
    const tickPromise = scheduler.tick();
    await scheduler.stop();
    await tickPromise; // resolves without error
    // After stop, calling start again should throw UNAVAILABLE.
    await assert.rejects(() => scheduler.start(), (error: unknown) =>
      error instanceof Error && /already closed/i.test(error.message),
    );
  } finally {
    await scheduler.stop();
    await worker.close();
  }
});
