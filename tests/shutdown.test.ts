/**
 * Tests for the shutdown flush watchdog. Pins the contract:
 *
 *   - Normal close resolves `done` as "completed" without invoking onTimeout.
 *   - A hung close (e.g. wedged fsync) trips the watchdog after the
 *     budget, invokes onTimeout, and resolves `done` as "timed-out".
 *   - A failing close (rejected promise) is logged but still resolves
 *     "completed" — a fast rejection shouldn't force-exit the app.
 *   - cancel() short-circuits the watchdog when the caller already
 *     settled successfully.
 */
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

test("rejected close logs the failure but still resolves 'completed'", async () => {
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
  assert.equal(outcome, "completed");
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
  assert.equal(outcome, "completed");
  // Wait long enough for the budget to elapse if cancel had no effect.
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(timeoutFired, false);
});
