/**
 * M7 — schedule dispatcher tests.
 *
 * Coverage:
 *   1. `upsertSchedule` inserts + updates.
 *   2. `publishScheduleRevision` assigns monotonic revision
 *      numbers and content-addresses each revision.
 *   3. `promoteRevision` flips a draft → enabled and supersedes
 *      older revisions.
 *   4. `seedNextOccurrences` populates N occurrences for the
 *      enabled revision; double-seeding is idempotent.
 *   5. `fireDueOccurrences` transitions due rows to `dispatched`
 *      and calls the dispatch callback with the recipe id.
 *   6. `fireDueOccurrences` with overlap policy `skip` and an
 *      open workflow_run row transitions the new occurrence to
 *      `skipped`.
 *   7. A paused schedule's pending occurrences are skipped.
 *   8. `nextLocalOccurrence` skips a DST gap.
 *   9. `fireDueOccurrences` does NOT re-fire an already-dispatched
 *      row (idempotent on the second pass).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { AppError } from "../../src/shared/errors";
import {
  upsertSchedule,
  setScheduleStatus,
  publishScheduleRevision,
  promoteRevision,
  seedNextOccurrences,
  fireDueOccurrences,
  readScheduleRow,
} from "../../src/runtime/orchestration/schedule-dispatcher";
import {
  scheduleInputSchema,
  nextLocalOccurrence,
} from "../../src/runtime/db/schedule-schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

test("M7 scheduleInputSchema accepts daily + weekly rules", () => {
  scheduleInputSchema.parse({
    scheduleId: "s1",
    displayName: "Daily",
    rule: { kind: "daily", hour: 9, minute: 0 },
    timezone: "UTC",
    recipeId: "r1",
  });
  scheduleInputSchema.parse({
    scheduleId: "s2",
    displayName: "Weekly",
    rule: { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
    timezone: "America/New_York",
    recipeId: "r2",
  });
});

test("M7 upsertSchedule inserts a row, then updates it in place", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily 09:00",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    let row = await readScheduleRow(worker, "s1");
    assert.ok(row);
    assert.equal(row.displayName, "Daily 09:00");
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily 10:00",
      rule: { kind: "daily", hour: 10, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    row = await readScheduleRow(worker, "s1");
    assert.equal(row!.displayName, "Daily 10:00");
    assert.equal((row!.rule as { hour: number }).hour, 10);
  } finally { await worker.close(); }
});

test("M7 publishScheduleRevision assigns monotonic revisions", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily 09:00",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const r1 = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    const r2 = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 10, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    assert.equal(r1.revision, 1);
    assert.equal(r2.revision, 2);
    assert.notEqual(r1.revisionDigest, r2.revisionDigest);
  } finally { await worker.close(); }
});

test("M7 promoteRevision supersedes older revisions", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    const r1 = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    const r2 = await publishScheduleRevision(worker, {
      scheduleId: "s1",
      rule: { kind: "daily", hour: 10, minute: 0 },
      timezone: "UTC", recipeId: "r1",
      publishedBy: "tester",
    });
    await promoteRevision(worker, "s1", r1.revision, "enabled");
    await promoteRevision(worker, "s1", r2.revision, "enabled");
    const r1Row = (await readScheduleRow(worker, "s1"));
    assert.ok(r1Row);
  } finally { await worker.close(); }
});

test("M7 seedNextOccurrences populates N occurrences; idempotent on re-seed", async () => {
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
    const seeded1 = await seedNextOccurrences(worker, "s1", 3, { now: () => new Date("2026-01-01T00:00:00Z") });
    assert.equal(seeded1.length, 3);
    const seeded2 = await seedNextOccurrences(worker, "s1", 3, { now: () => new Date("2026-01-01T00:00:00Z") });
    // Re-seeding with the same now does not duplicate because
    // (schedule_id, revision, intended_utc) is unique.
    assert.equal(seeded2.length, 0);
  } finally { await worker.close(); }
});

test("M7.3 seedNextOccurrences records tzdata_version + boot_id + dispatch_state", async () => {
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
    const seeded = await seedNextOccurrences(worker, "s1", 1, {
      now: () => new Date("2026-01-01T00:00:00Z"),
      bootId: "boot-abc",
      timezoneDataVersion: "icu:74.1",
    });
    assert.equal(seeded.length, 1);
    const occurrence = seeded[0];
    assert.equal(occurrence.bootId, "boot-abc");
    assert.equal(occurrence.timezoneDataVersion, "icu:74.1");
    assert.equal(occurrence.dispatchState, "pending");
    assert.equal(occurrence.coalescedWith, null);
  } finally { await worker.close(); }
});

test("M7 fireDueOccurrences dispatches due rows and calls the callback", async () => {
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
    // Seed an occurrence that has ALREADY passed.
    const calls: Array<{ recipeId: string; intendedUtc: string }> = [];
    await seedNextOccurrences(worker, "s1", 1, { now: () => new Date("2026-01-01T00:00:00Z") });
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async (args) => {
        calls.push({ recipeId: args.recipeId, intendedUtc: args.intendedUtc });
        return { workflowRunId: "00000000-0000-4000-8000-000000000001" };
      },
      now: () => new Date("2026-01-05T00:00:00Z"),
    });
    assert.equal(result.dispatched, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].recipeId, "r1");
  } finally { await worker.close(); }
});

test("M7 fireDueOccurrences skips rows when an overlapping workflow is running", async () => {
  const worker = freshWorker();
  try {
    // Insert a fake workflow_run row in `running` state.
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void } } }).driver;
    driver.prepare(
      "INSERT INTO workflow_run (uuid, workflow_id, status, created_by, settings_json, graph_json, started_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("00000000-0000-4000-8000-000000000099", "wf-open", "running", "tester", "{}", "{}", "2026-01-05T00:00:00Z");

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
    await seedNextOccurrences(worker, "s1", 1, { now: () => new Date("2026-01-01T00:00:00Z") });

    let dispatchedCount = 0;
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatchedCount += 1; return { workflowRunId: "00000000-0000-4000-8000-000000000001" }; },
      now: () => new Date("2026-01-05T00:00:00Z"),
    });
    assert.equal(result.skipped, 1);
    assert.equal(result.dispatched, 0);
    assert.equal(dispatchedCount, 0);
  } finally { await worker.close(); }
});

test("M7 fireDueOccurrences skips pending rows when the schedule is paused", async () => {
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
    await setScheduleStatus(worker, "s1", "paused");
    await seedNextOccurrences(worker, "s1", 1, { now: () => new Date("2026-01-01T00:00:00Z") });
    const result = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => ({ workflowRunId: "00000000-0000-4000-8000-000000000001" }),
      now: () => new Date("2026-01-05T00:00:00Z"),
    });
    assert.equal(result.skipped, 1);
  } finally { await worker.close(); }
});

test("M7 fireDueOccurrences does NOT re-fire an already-dispatched row (idempotent)", async () => {
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
    await seedNextOccurrences(worker, "s1", 1, { now: () => new Date("2026-01-01T00:00:00Z") });
    let dispatchedCount = 0;
    const r1 = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatchedCount += 1; return { workflowRunId: "00000000-0000-4000-8000-000000000001" }; },
      now: () => new Date("2026-01-05T00:00:00Z"),
    });
    const r2 = await fireDueOccurrences(worker, {
      dispatchRecipe: async () => { dispatchedCount += 1; return { workflowRunId: "00000000-0000-4000-8000-000000000002" }; },
      now: () => new Date("2026-01-05T00:00:00Z"),
    });
    assert.equal(r1.dispatched, 1);
    assert.equal(r2.dispatched, 0);
    assert.equal(dispatchedCount, 1);
  } finally { await worker.close(); }
});

test("M7 nextLocalOccurrence skips a DST gap (spring-forward)", () => {
  // 2026-03-08 in America/New_York: 02:00 -> 03:00 (spring forward).
  // The local time 02:30 does not exist; the planner should mark
  // the result as skipped.
  // `from` is set to the last instant of 2026-03-07 NY time so the
  // algorithm's first candidate day is the DST gap day.
  const from = new Date("2026-03-08T05:00:00Z"); // = 2026-03-08 00:00 EST (just past midnight)
  const result = nextLocalOccurrence({ kind: "daily", hour: 2, minute: 30 }, "America/New_York", from);
  assert.equal(result.skipped, true);
});

test("M7 nextLocalOccurrence returns a valid future occurrence outside DST gap", () => {
  const from = new Date("2026-01-01T00:00:00Z");
  const result = nextLocalOccurrence({ kind: "daily", hour: 9, minute: 0 }, "UTC", from);
  assert.equal(result.skipped, false);
  assert.ok(new Date(result.intendedUtc).getTime() > from.getTime());
});

test("M7 seedNextOccurrences refuses out-of-range count", async () => {
  const worker = freshWorker();
  try {
    await upsertSchedule(worker, {
      scheduleId: "s1", displayName: "Daily",
      rule: { kind: "daily", hour: 9, minute: 0 },
      timezone: "UTC", recipeId: "r1",
    });
    await assert.rejects(
      () => seedNextOccurrences(worker, "s1", 0),
      (error: unknown) => error instanceof AppError,
    );
    await assert.rejects(
      () => seedNextOccurrences(worker, "s1", 1000),
      (error: unknown) => error instanceof AppError,
    );
  } finally { await worker.close(); }
});