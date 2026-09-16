/**
 * M5.6 — memory-view IPC tests.
 *
 * Coverage (8 focused tests):
 *  - viewSessionMemoryInputSchema requires sessionId
 *  - viewSessionMemoryInputSchema rejects sessionId > 256 chars
 *  - viewSessionMemoryInputSchema rejects maxTasks > 64
 *  - viewTerminalMemoryInputSchema requires a UUID terminalUuid
 *  - viewTerminalMemoryInputSchema caps maxLines at 4096
 *  - viewTaskMemoryInputSchema requires a UUID taskId
 *  - viewTaskMemoryInputSchema caps maxEvents at 256
 *  - all three schemas reject unknown top-level fields
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  viewSessionMemoryInputSchema,
  viewTaskMemoryInputSchema,
  viewTerminalMemoryInputSchema,
} from "../../src/shared/workspace6-schema";

test("viewSessionMemoryInputSchema requires sessionId", () => {
  assert.throws(() => viewSessionMemoryInputSchema.parse({}));
});

test("viewSessionMemoryInputSchema rejects sessionId > 256 chars", () => {
  const long = "a".repeat(257);
  assert.throws(() => viewSessionMemoryInputSchema.parse({ sessionId: long }));
});

test("viewSessionMemoryInputSchema rejects maxTasks > 64", () => {
  assert.throws(() => viewSessionMemoryInputSchema.parse({ sessionId: "s", maxTasks: 65 }));
});

test("viewSessionMemoryInputSchema accepts an optional maxTasks", () => {
  const out = viewSessionMemoryInputSchema.parse({ sessionId: "s", maxTasks: 32 });
  assert.equal(out.maxTasks, 32);
});

test("viewTerminalMemoryInputSchema requires a UUID terminalUuid", () => {
  assert.throws(() => viewTerminalMemoryInputSchema.parse({ terminalUuid: "not-a-uuid" }));
});

test("viewTerminalMemoryInputSchema caps maxLines at 4096", () => {
  assert.throws(() => viewTerminalMemoryInputSchema.parse({ terminalUuid: randomUUID(), maxLines: 5000 }));
});

test("viewTaskMemoryInputSchema requires a UUID taskId", () => {
  assert.throws(() => viewTaskMemoryInputSchema.parse({ taskId: "not-a-uuid" }));
});

test("viewTaskMemoryInputSchema caps maxEvents at 256", () => {
  assert.throws(() => viewTaskMemoryInputSchema.parse({ taskId: randomUUID(), maxEvents: 1000 }));
});

test("all three schemas reject unknown top-level fields", () => {
  assert.throws(() => viewSessionMemoryInputSchema.parse({ sessionId: "s", bogus: true }));
  assert.throws(() => viewTerminalMemoryInputSchema.parse({ terminalUuid: randomUUID(), bogus: true }));
  assert.throws(() => viewTaskMemoryInputSchema.parse({ taskId: randomUUID(), bogus: true }));
});
