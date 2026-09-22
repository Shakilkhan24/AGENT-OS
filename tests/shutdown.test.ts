/** Shutdown outcomes distinguish completed, failed, cancelled and timed-out work. */
import test from "node:test";
import assert from "node:assert/strict";
import { runWithWatchdog } from "../src/main/shutdown";
import type { LogEntry } from "../src/main/logging";

function makeLogger() {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(entry: LogEntry) { entries.push(entry); },
  };
}

test("normal close resolves as 'completed' without tripping the timeout", async () => {
  const logger = makeLogger();
  let timeoutFired = false;
  const result = runWithWatchdog(async () => {
    await new Promise((r) => setTimeout(r, 10));
  }, { budgetMs: 200, onTimeout: () => { timeoutFired = true; }, log: logger.log });
  const outcome = await result.done;
  assert.equal(outcome, "completed");
  assert.equal(timeoutFired, false);
  assert.equal(logger.entries.length, 0);
});

test("hung close trips the watchdog after the budget and invokes onTimeout", async () => {
  const logger = makeLogger();
  let timeoutFired = false;
  const result = runWithWatchdog(() => new Promise<void>(() => {}), {
    budgetMs: 50,
    onTimeout: () => { timeoutFired = true; },
    log: logger.log,
  });
  const outcome = await result.done;
  assert.equal(outcome, "timed-out");
  assert.equal(timeoutFired, true);
  // Log entry should be a structured error mentioning the budget.
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].event, "shutdown-flush-timeout");
  assert.equal(logger.entries[0].fields?.budgetMs, 50);
});

test("rejected close logs the failure and resolves as failed", async () => {
  const logger = makeLogger();
  let timeoutFired = false;
  const result = runWithWatchdog(async () => {
    throw new Error("disk full");
  }, {
    budgetMs: 500,
    onTimeout: () => { timeoutFired = true; },
    log: logger.log,
  });
  const outcome = await result.done;
  assert.equal(outcome, "failed");
  assert.equal(timeoutFired, false);
  // Failure is logged so the operator can see why we shut down dirty.
  assert.equal(logger.entries.length, 1);
  assert.equal(logger.entries[0].event, "shutdown-flush-failed");
});

test("cancel() prevents the watchdog from firing after a successful close", async () => {
  const logger = makeLogger();
  let timeoutFired = false;
  const result = runWithWatchdog(async () => {
    await new Promise((r) => setTimeout(r, 10));
  }, {
    budgetMs: 50,
    onTimeout: () => { timeoutFired = true; },
    log: logger.log,
  });
  result.cancel();
  const outcome = await result.done;
  assert.equal(outcome, "cancelled");
  // Wait long enough for the budget to elapse if cancel had no effect.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(timeoutFired, false);
});
