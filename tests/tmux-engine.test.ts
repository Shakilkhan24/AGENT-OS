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
  // Wait for the wait-for observer to wake us. The pane runs `sleep 0.8;
  // exit 17`, so the observer should fire well within a second on a normal
  // box, but a loaded CI runner can take several seconds to drive the
  // socket + pipe back through `pane-exit`. 200 × 50 ms = 10 s ceiling.
  for (let attempt = 0; !pushed && attempt < 200; attempt++) await delay(50);
  assert.ok(pushed > 0, "pane-died wakes a wait-for observer without polling");
  const pane = (await engine.inspect()).get(id)!;
  assert.equal(pane.dead, true);
  assert.equal(pane.exitCode, 17);
  assert.ok(pane.endedAt);
  assert.equal(await readFile(path.join(cwd, "result"), "utf8"), "literal $() ; ✓");
  unsubscribe();
  assert.equal((await engine.inspect()).has(id), true, "closing the observer preserves terminal history");
});
