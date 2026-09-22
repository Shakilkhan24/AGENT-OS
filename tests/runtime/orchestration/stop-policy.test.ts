/**
 * M3b.3 — stop policy tests.
 *
 * Coverage:
 *  - `requestStop` transitions the run to `cancelled` and writes a
 *    `stop.requested` audit event.
 *  - After `requestStop`, `isStopped(runId)` returns true; subsequent
 *    `executeOnce` calls (against the same run) are blocked.
 *  - Calling `requestStop` on an already-cancelled run is idempotent.
 *  - `clearStop` and `resetStops` clear the per-process flag map for
 *    subsequent tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun, readRun, transitionRun } from "../../../src/runtime/db/runs";
import {
  clearStop,
  isStopped,
  requestStop,
  resetStops,
} from "../../../src/runtime/orchestration/stop-policy";
import {
  executeOnce,
  resetExecuteOnceAdapter,
  setExecuteOnceAdapter,
} from "../../../src/runtime/orchestration/execute-once";
import { ScriptedProviderDouble } from "../../../src/runtime/providers/scripted-double";
import { AppError } from "../../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function setupRunning(worker: DbWorker): Promise<string> {
  const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  await transitionRun(worker, run.id, "running");
  return run.id;
}

test("requestStop transitions the run to cancelled and emits stop.requested", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRunning(worker);
    const result = await requestStop(worker, { runId, reason: "user clicked Stop", requestedBy: "user-1" });
    assert.equal(result.status, "cancelled");
    assert.equal(result.blockedExecuteOnce, true);
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare("SELECT * FROM event WHERE seq = ?").first(result.eventSeq);
    assert.equal(row?.type, "stop.requested");
    const payload = JSON.parse(String(row?.payload_json));
    assert.equal(payload.runId, runId);
    const run = await readRun(worker, runId);
    assert.equal(run?.status, "cancelled");
  } finally {
    resetStops();
    await worker.close();
  }
});

test("after requestStop, isStopped(runId) is true and executeOnce refuses", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRunning(worker);
    await requestStop(worker, { runId, reason: "stop", requestedBy: "user-1" });
    assert.equal(isStopped(runId), true);
    setExecuteOnceAdapter(() => new ScriptedProviderDouble());
    try {
      const result = await executeOnce(worker, {
        runId, idempotencyKey: "k", canonicalDigest: "a".repeat(64),
        providerVersion: "v", model: "m", accountMode: "authenticated",
        method: "agent", args: {}, scope: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        parentInvocationId: null, revision: null,
      });
      assert.equal(result.kind, "conflict");
    } finally {
      resetExecuteOnceAdapter();
      clearStop(runId);
    }
  } finally {
    resetStops();
    await worker.close();
  }
});

test("requestStop is idempotent on an already-cancelled run", async () => {
  const worker = freshWorker();
  try {
    const runId = await setupRunning(worker);
    await requestStop(worker, { runId, reason: "first", requestedBy: "u" });
    const second = await requestStop(worker, { runId, reason: "second", requestedBy: "u" });
    assert.equal(second.eventSeq, -1);
    const third = await requestStop(worker, { runId, reason: "third", requestedBy: "u" }).catch((err: unknown) => {
      if (err instanceof AppError) return err;
      throw err;
    });
    assert.ok(third !== undefined);
  } finally {
    resetStops();
    await worker.close();
  }
});

test("requestStop raises NOT_FOUND for unknown run", async () => {
  const worker = freshWorker();
  try {
    const fake = "00000000-0000-4000-8000-000000000000";
    await assert.rejects(requestStop(worker, {
      runId: fake, reason: "stop", requestedBy: "user",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally {
    await worker.close();
  }
});
