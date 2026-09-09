import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TmuxEngine } from "../src/main/tmux-engine";
import { defaultSettings } from "../src/shared/settings";

test("graceful stop escalates against a resistant tree and preserves unrelated terminals", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-stop-"));
  const engine = new TmuxEngine(root, path.resolve("helpers/pty_bridge.py"), { ...defaultSettings, shellMode: "clean", gracefulStopMs: 100 });
  t.after(async () => {
    engine.close();
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(root, { recursive: true, force: true });
  });
  await engine.initialize();
  const id = randomUUID(), other = randomUUID();
  const record = { label: "Stop", cwd: root, createdAt: new Date().toISOString(), command: "trap '' INT TERM; sleep 120 & wait" };
  await engine.create({ ...record, id });
  await engine.create({ ...record, id: other });
  await delay(100);
  const pid = (await engine.inspect()).get(id)!.pid;
  const stages: string[] = [];
  const report = await engine.stop(id, "graceful", stage => { stages.push(stage); });
  assert.deepEqual(stages, ["interrupt", "term", "kill", "removed"]);
  assert.ok(report.signalled.includes(pid));
  assert.deepEqual(report.remaining, []);
  assert.equal((await engine.inspect()).has(id), false);
  assert.equal((await engine.inspect()).get(other)?.dead, false);
  assert.equal((await engine.stop(id, "force", () => {})).remaining.length, 0);
});
