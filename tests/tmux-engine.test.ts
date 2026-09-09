import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TmuxEngine } from "../src/main/tmux-engine";
import { defaultSettings } from "../src/shared/settings";

test("the tmux adapter isolates environment, preserves odd paths and pushes exit status", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-adapter-"));
  const cwd = path.join(root, "λ\tline\n,project");
  await mkdir(cwd);
  const engine = new TmuxEngine(path.join(root, "profile"), path.resolve("helpers/pty_bridge.py"), { ...defaultSettings, shellMode: "clean" });
  t.after(async () => {
    engine.close();
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(root, { recursive: true, force: true });
  });
  await engine.initialize();
  const id = randomUUID();
  let pushed = 0;
  const unsubscribe = engine.onChange(() => { pushed++; });
  await engine.create({ id, label: "Environment", cwd, command: 'printf "%s" "$MINIMAL_TEST_VALUE" > result; sleep 0.8; exit 17', createdAt: new Date().toISOString(), env: { MINIMAL_TEST_VALUE: "literal $() ; ✓" } });
  assert.equal((await engine.inspect()).get(id)?.cwd, cwd);
  for (let attempt = 0; !pushed && attempt < 100; attempt++) await delay(50);
  assert.ok(pushed > 0, "pane-died wakes a wait-for observer without polling");
  const pane = (await engine.inspect()).get(id)!;
  assert.equal(pane.dead, true);
  assert.equal(pane.exitCode, 17);
  assert.ok(pane.endedAt);
  assert.equal(await readFile(path.join(cwd, "result"), "utf8"), "literal $() ; ✓");
  unsubscribe();
  assert.equal((await engine.inspect()).has(id), true, "closing the observer preserves terminal history");
});
