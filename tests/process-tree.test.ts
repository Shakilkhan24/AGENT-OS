import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProcessTree, parseProcStat } from "../src/main/process-tree";

function proc(pid: number, parent: number, start: number) {
  return `${pid} (name ) with spaces) S ${parent} ${Array(17).fill("0").join(" ")} ${start} 0`;
}
test("process accounting handles comm delimiters and refuses PID reuse before signalling", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uid = process.getuid!();
  assert.equal(parseProcStat(proc(201, 200, 12345), uid).start, "12345");
  for (const [pid, parent] of [[200, 1], [201, 200], [202, 201], [300, 1]]) {
    await mkdir(`${root}/${pid}`);
    await writeFile(`${root}/${pid}/stat`, proc(pid, parent, 10));
  }
  const signals: number[] = [];
  const tree = await new ProcessTree(root, uid, pid => { signals.push(pid); }).capture(200);
  await writeFile(`${root}/201/stat`, proc(201, 1, 99));
  await tree.signal("SIGTERM");
  assert.deepEqual(signals, [202, 200]);
  assert.deepEqual(await tree.remaining(), [200, 202]);
  assert.equal(tree.incomplete, false);
});
