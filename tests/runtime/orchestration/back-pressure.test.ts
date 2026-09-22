/**
 * M3b.2 — back-pressure / byte-budget writer.
 *
 * Coverage:
 *  - delivery below the low watermark never pauses.
 *  - delivery past the high watermark flips to paused.
 *  - acknowledge back below the low watermark flips back to running.
 *  - the writer refuses negative byte counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  HIGH_WATERMARK,
  LOW_WATERMARK,
  createBudgetedWriter,
} from "../../../src/runtime/orchestration/back-pressure";

function makeTracker() {
  const log: string[] = [];
  return {
    log,
    writer: createBudgetedWriter({
      pause: () => log.push("pause"),
      resume: () => log.push("resume"),
    }),
  };
}

test("delivery below the low watermark never invokes pause", () => {
  const { log, writer } = makeTracker();
  writer.deliver(LOW_WATERMARK - 1);
  assert.equal(log.length, 0);
  assert.equal(writer.paused, false);
  assert.equal(writer.outstanding, LOW_WATERMARK - 1);
});

test("delivery at or past the high watermark invokes pause exactly once", () => {
  const { log, writer } = makeTracker();
  writer.deliver(HIGH_WATERMARK);
  assert.deepEqual(log, ["pause"]);
  // A second overflow should not re-pause.
  writer.deliver(1);
  assert.deepEqual(log, ["pause"]);
  assert.equal(writer.paused, true);
});

test("acknowledging across the low watermark invokes resume", () => {
  const { log, writer } = makeTracker();
  writer.deliver(HIGH_WATERMARK + 10);
  // Acknowledge a small amount — still above the low watermark.
  writer.acknowledge(10);
  assert.equal(writer.paused, true);
  assert.deepEqual(log, ["pause"]);
  // Acknowledge past the low watermark → resume.
  writer.acknowledge(writer.outstanding - (LOW_WATERMARK - 1));
  assert.equal(writer.paused, false);
  assert.deepEqual(log, ["pause", "resume"]);
});

test("acknowledge below outstanding floor zeros the counter", () => {
  const { writer } = makeTracker();
  writer.deliver(100);
  writer.acknowledge(200);
  assert.equal(writer.outstanding, 0);
});

test("negative byte counts are rejected", () => {
  const { writer } = makeTracker();
  assert.throws(() => writer.deliver(-1), /negative/);
  assert.throws(() => writer.acknowledge(-1), /negative/);
});

test("reset clears state and resumes", () => {
  const { log, writer } = makeTracker();
  writer.deliver(HIGH_WATERMARK + 1);
  writer.reset();
  assert.equal(writer.outstanding, 0);
  assert.equal(writer.paused, false);
  assert.deepEqual(log, ["pause", "resume"]);
});
