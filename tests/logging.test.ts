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
