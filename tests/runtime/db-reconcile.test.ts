/**
 * Focused tests for M2.7 — reconcile surviving execution against the
 * restored state.
 *
 * Coverage:
 *  - DB-only terminals (not in the surviving set) are marked missing;
 *  - surviving-only terminals are reported as orphan;
 *  - present-in-both rows are reported as aligned;
 *  - the audit event captures the diff;
 *  - reconciliation runs against an empty DB without throwing;
 *  - `discoverSurviving` returning undefined is rejected.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { reconcileSurvivingExecution, withSurvivingSet } from "../../src/runtime/db/reconcile";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return new DbWorker({ driver });
}

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}

async function seedTerminal(worker: DbWorker, uuid: string, label: string): Promise<void> {
  const driver = (worker as unknown as { driver: DriverRaw }).driver;
  driver.prepare(
    "INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, " +
    "env_json, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(uuid, 0, label, "/tmp", "bash", new Date().toISOString(), 0, null, "{}", "{}");
}

test("reconcileSurvivingExecution marks DB-only terminals as missing", async () => {
  const worker = freshWorker();
  try {
    await seedTerminal(worker, "11111111-1111-4111-8111-111111111111", "alpha");
    await seedTerminal(worker, "22222222-2222-4222-8222-222222222222", "beta");
    const report = await reconcileSurvivingExecution({
      worker,
      discoverSurviving: () => new Set(["11111111-1111-4111-8111-111111111111"]),
    });
    assert.equal(report.missing.length, 1);
    assert.equal(report.missing[0], "22222222-2222-4222-8222-222222222222");
    assert.equal(report.aligned.length, 1);
    assert.equal(report.orphan.length, 0);
    const driver = (worker as unknown as { driver: DriverRaw }).driver;
    const row = driver.prepare("SELECT deleting, deletion_policy FROM terminal WHERE uuid = ?")
      .first("22222222-2222-4222-8222-222222222222") as { deleting: number; deletion_policy: string } | undefined;
    assert.equal(row?.deleting, 1);
    assert.equal(row?.deletion_policy, "survivor-gone");
  } finally { await worker.close(); }
});

test("reconcileSurvivingExecution reports surviving-only terminals as orphan", async () => {
  const worker = freshWorker();
  try {
    await seedTerminal(worker, "33333333-3333-4333-8333-333333333333", "alpha");
    const report = await reconcileSurvivingExecution({
      worker,
      discoverSurviving: () => new Set([
        "33333333-3333-4333-8333-333333333333",
        "44444444-4444-4444-8444-444444444444",
      ]),
    });
    assert.equal(report.aligned.length, 1);
    assert.equal(report.orphan.length, 1);
    assert.equal(report.orphan[0], "44444444-4444-4444-8444-444444444444");
  } finally { await worker.close(); }
});

test("reconcileSurvivingExecution emits an audit event with the diff", async () => {
  const worker = freshWorker();
  try {
    await seedTerminal(worker, "55555555-5555-4555-8555-555555555555", "alpha");
    await seedTerminal(worker, "66666666-6666-4666-8666-666666666666", "beta");
    await reconcileSurvivingExecution({
      worker,
      discoverSurviving: () => new Set(["55555555-5555-4555-8555-555555555555"]),
    });
    const driver = (worker as unknown as { driver: DriverRaw }).driver;
    const events = driver.prepare("SELECT type, payload_json FROM event").all();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.type, "execution.reconciled");
    const payload = JSON.parse(String(events[0]?.payload_json));
    assert.equal(payload.missing.length, 1);
    assert.equal(payload.orphan.length, 0);
    assert.equal(payload.aligned, 1);
  } finally { await worker.close(); }
});

test("reconcileSurvivingExecution tolerates an empty terminal table", async () => {
  const worker = freshWorker();
  try {
    const report = await reconcileSurvivingExecution({
      worker,
      discoverSurviving: () => new Set(),
    });
    assert.equal(report.missing.length, 0);
    assert.equal(report.aligned.length, 0);
    assert.equal(report.orphan.length, 0);
  } finally { await worker.close(); }
});

test("reconcileSurvivingExecution rejects a non-Set discoverSurviving result", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      reconcileSurvivingExecution({ worker, discoverSurviving: () => undefined as unknown as ReadonlySet<string> }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("withSurvivingSet normalises an iterable into a Set", () => {
  const set = withSurvivingSet(["a", "b", "a"]);
  assert.equal(set.size, 2);
  assert.equal(set.has("a"), true);
});

test("withSurvivingSet rejects undefined input", () => {
  assert.throws(() => withSurvivingSet(undefined), (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST");
});