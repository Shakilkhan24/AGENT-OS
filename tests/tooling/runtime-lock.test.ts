import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, chmod, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const fixture = `
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const lock = fs.readlinkSync('/proc/self/fd/'+process.env.MINIMAL_LOCK_FD);
const code = "const fs=require('node:fs'); process.stdout.write(JSON.stringify(fs.readdirSync('/proc/self/fd').flatMap(n=>{try{return [fs.readlinkSync('/proc/self/fd/'+n)]}catch{return []}})))";
if (JSON.parse(execFileSync(process.execPath,['-e',code],{encoding:'utf8'})).includes(lock)) process.exit(2);
process.stdout.write('ready\\n');
setInterval(()=>{}, 1000);
`;
function start(lock: string) {
  return spawn("python3", ["helpers/runtime_lock.py", lock, process.execPath, "-e", fixture], { stdio: ["ignore", "pipe", "pipe"] });
}

test("runtime lock excludes another owner, does not leak, and releases on SIGKILL without inode deletion", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-lock-")), lock = path.join(root, "owner.lock");
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = start(lock);
  t.after(() => first.kill("SIGKILL"));
  assert.match(String((await once(first.stdout, "data"))[0]), /ready/);
  const inode = (await stat(lock)).ino;
  const competitor = start(lock);
  assert.equal((await once(competitor, "exit"))[0], 73);
  const exit = once(first, "exit"); first.kill("SIGKILL"); await exit;
  const next = start(lock);
  t.after(() => next.kill("SIGKILL"));
  assert.match(String((await once(next.stdout, "data"))[0]), /ready/);
  assert.equal((await stat(lock)).ino, inode);
  const done = once(next, "exit"); next.kill("SIGTERM"); await done;
});

test("runtime lock refuses a symlink or shared permissions", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-lock-perms-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "original"), link = path.join(root, "link");
  await writeFile(target, "preserve"); await symlink(target, link);
  for (const file of [link, target]) {
    if (file === target) await chmod(target, 0o644);
    const child = start(file);
    assert.equal((await once(child, "exit"))[0], 1);
  }
});
