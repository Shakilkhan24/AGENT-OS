import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { reapTmuxChildren } from "../src/main/tmux-recovery";

test("exit recovery signals only a same-user server with an unreaped child from its pane map", async (t) => {
  const root = await mkdtemp('/tmp/minimal-reap-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const record = async (pid: number, parent: number, state: string) => {
    await mkdir(`${root}/${pid}`, { recursive: true });
    await writeFile(`${root}/${pid}/stat`, `${pid} (test) ${state} ${parent} ${Array(17).fill('0').join(' ')} 1234`);
  };
  await record(100, 1, "S"); await record(101, 100, "Z");
  const panes = new Map([["a", { id: "a", pid: 101, process: "bash", cwd: "", dead: true }]]);
  const signals: [number, string | number | undefined][] = [];
  const signal: typeof process.kill = (pid, sig) => { signals.push([pid, sig]); return true; };
  assert.equal(await reapTmuxChildren(panes, async () => 100, root, signal), true);
  assert.deepEqual(signals, [[100, "SIGCHLD"]]);
  await record(101, 999, "Z");
  assert.equal(await reapTmuxChildren(panes, async () => 100, root, signal), false);
  await record(101, 100, "S");
  assert.equal(await reapTmuxChildren(panes, async () => 100, root, signal), false);
  assert.equal(signals.length, 1);
});
