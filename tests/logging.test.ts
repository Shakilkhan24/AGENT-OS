import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Logger } from "../src/main/logging";
test("logs rotate by day, retain correlation IDs and omit private payload fields", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let day = new Date("2026-09-09T10:00:00Z");
  const logger = new Logger(root, 2, () => day);
  const correlationId = crypto.randomUUID();
  await logger.write({
    level: "info",
    source: "test",
    event: "operation",
    correlationId,
    fields: {
      command: "secret command",
      nested: { token: "secret token" },
      durationMs: 42,
    },
  });
  const entry = JSON.parse(
    await readFile(path.join(root, "2026-09-09.ndjson"), "utf8"),
  );
  assert.equal(entry.correlationId, correlationId);
  assert.deepEqual(entry.fields, {
    command: "[redacted]",
    nested: { token: "[redacted]" },
    durationMs: 42,
  });
  day = new Date("2026-09-12T10:00:00Z");
  await logger.write({ level: "error", source: "test", event: "failure" });
  assert.deepEqual(await readdir(root), ["2026-09-12.ndjson"]);
});

test("Logger skips protected day files at rollover", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-logs-floor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let day = new Date("2026-09-09T10:00:00Z");
  const logger = new Logger(root, 1, () => day);
  // Operational entry on day 1.
  await logger.write({ level: "info", source: "test", event: "ops" });
  // Protected entry on day 2.
  day = new Date("2026-09-10T10:00:00Z");
  await logger.write({
    level: "info",
    source: "test",
    event: "protected",
    retentionClass: "pending-decision",
  });
  // Advance past the retention window. Day 1 (operational) should be
  // rotated out; day 2 (protected) must be preserved.
  day = new Date("2026-09-12T10:00:00Z");
  await logger.write({ level: "info", source: "test", event: "fresh" });
  const remaining = (await readdir(root)).sort();
  assert.equal(remaining.includes("2026-09-09.ndjson"), false);
  assert.equal(remaining.includes("2026-09-10.ndjson"), true);
  assert.equal(remaining.includes("2026-09-12.ndjson"), true);
});

test("applyRetentionClasses is a test seam", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-logs-seam-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let day = new Date("2026-09-09T10:00:00Z");
  const logger = new Logger(root, 1, () => day);
  await logger.write({ level: "info", source: "test", event: "ops" });
  // Mark the current day as protected via the seam, then advance
  // past the retention window — the file must survive.
  logger.applyRetentionClasses(["live-intent"]);
  day = new Date("2026-09-15T10:00:00Z");
  await logger.write({ level: "info", source: "test", event: "fresh" });
  const remaining = (await readdir(root)).sort();
  assert.equal(remaining.includes("2026-09-09.ndjson"), true);
  assert.equal(logger.protectedDayCount() >= 1, true);
});

test("LogEntry accepts retentionClass field without breaking serialisation", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-logs-class-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let day = new Date("2026-09-09T10:00:00Z");
  const logger = new Logger(root, 1, () => day);
  await logger.write({
    level: "info",
    source: "test",
    event: "protected-write",
    retentionClass: "recoverable-candidate",
    fields: { hostId: "host-1", byteCount: 12 },
  });
  const lines = (await readFile(path.join(root, "2026-09-09.ndjson"), "utf8"))
    .trim()
    .split("\n");
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.retentionClass, "recoverable-candidate");
  assert.equal(entry.fields.hostId, "host-1");
  assert.equal(entry.fields.byteCount, 12);
});
