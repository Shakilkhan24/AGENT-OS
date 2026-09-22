import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import assert from "node:assert/strict";

// M0 probe only. No default application data path is ever opened.
const execute = promisify(execFile);
const exec = (command: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) =>
  execute(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 256 * 1024, ...options });
const args = process.argv.slice(2), systemd = args.includes("--systemd");
const flag = args.indexOf("--executable");
const executable = path.resolve(flag < 0 ? `release/current-linux-${process.arch}/minimal` : args[flag + 1]);
const base = await mkdtemp(path.join(tmpdir(), "minimal-runtime-spike-"));
const bin = path.join(base, "bin"); await mkdir(bin);
for (const name of ["tmux", "sleep", "bash"]) {
  const { stdout } = await exec("/bin/sh", ["-c", 'command -v "$1"', "resolve", name]);
  await symlink(stdout.trim(), path.join(bin, name));
}
const python = (await exec("/bin/sh", ["-c", "command -v python3"])).stdout.trim();
const fixture = path.resolve("tests/fixtures/runtime-spike.cjs");
const helper = path.join(path.dirname(executable), "resources/app/dist/helpers/runtime_lock.py");
const lock = path.join(base, "owner.lock"), ready = path.join(base, "ready.json");
const command = [helper, lock, executable, fixture, base, "write"];
const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", PATH: bin, DISPLAY: "", WAYLAND_DISPLAY: "", NODE_OPTIONS: "" };
const unit = `minimal-spike-${crypto.randomUUID()}`;
const owned = new Set<number>();
let child: ReturnType<typeof spawn> | undefined;
let unitCreated = false;
async function waitReady() {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return JSON.parse(await readFile(ready, "utf8")) as { pid: number; panePid: number; versions: Record<string, string>; cgroup: string }; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  throw new Error("Packaged runtime did not report readiness in 10 seconds");
}
async function start() {
  await rm(ready, { force: true });
  if (systemd) {
    if (unitCreated) await exec("systemctl", ["--user", "start", unit]);
    else await exec("systemd-run", ["--user", `--unit=${unit}`, "--property=KillMode=process", "--property=Restart=no", "--property=TimeoutStopSec=5",
      "--setenv=ELECTRON_RUN_AS_NODE=1", `--setenv=PATH=${bin}`, "--setenv=DISPLAY=", "--setenv=WAYLAND_DISPLAY=", "--setenv=NODE_OPTIONS=",
      python, ...command]);
    unitCreated = true;
  } else {
    child = spawn(python, command, { env, detached: true, stdio: "ignore" });
    child.unref();
  }
  const result = await waitReady(); owned.add(result.pid); return result;
}
async function stop(pid: number, signal: "SIGTERM" | "SIGKILL") {
  if (systemd) {
    if (signal === "SIGKILL") await exec("systemctl", ["--user", "kill", "--kill-who=main", "--signal=SIGKILL", unit]);
    await exec("systemctl", ["--user", "stop", unit]);
  } else if (child && child.exitCode === null && child.signalCode === null) {
    child.ref(); // Keep the harness alive until the detached child's exit is observed.
    const done = once(child, "exit"); process.kill(pid, signal); await done;
  }
  owned.delete(pid);
}
try {
  const first = await start();
  const inode = (await stat(lock)).ino;
  const [major, minor, patch] = first.versions.sqlite.split(".").map(Number);
  assert.ok(major > 3 || major === 3 && (minor > 51 || minor === 51 && patch >= 3), "Require WAL-reset fix in the shipped SQLite engine");
  await assert.rejects(exec(python, command, { env }), error => (error as { code?: number }).code === 73);
  await stop(first.pid, "SIGKILL");
  const read = async () => JSON.parse((await exec(executable, [fixture, base, "read"], { env })).stdout);
  const recovered = await read();
  assert.equal(recovered.rows.length, 1);
  assert.equal(recovered.rows[0].note, "acknowledged α🌍");
  assert.equal(recovered.integrity.integrity_check, "ok");
  const second = await start();
  assert.equal(second.panePid, first.panePid, "cold-started tmux work survives owner death and reuse");
  assert.equal((await stat(lock)).ino, inode);
  await stop(second.pid, "SIGTERM");
  const final = await read(); assert.equal(final.rows.length, 2);
  const pane = (await exec("tmux", ["-S", path.join(base, "tmux.sock"), "display-message", "-p", "-t", "spike", "#{pane_pid}"])).stdout.trim();
  assert.equal(Number(pane), first.panePid);
  process.stdout.write(JSON.stringify({ mode: systemd ? "systemd-user KillMode=process" : "detached", node: first.versions.node, sqlite: first.versions.sqlite,
    cgroup: first.cgroup, globalNodeOnPath: false, display: false, duplicateOwnerRejected: true, lockInodePreserved: true,
    acknowledgedRowsRecovered: final.rows.length, uncommittedRowsRecovered: 0, terminalPidPreserved: true }) + "\n");
} finally {
  if (systemd) await exec("systemctl", ["--user", "stop", unit]).catch(() => {});
  for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await exec("tmux", ["-S", path.join(base, "tmux.sock"), "kill-server"]).catch(() => {});
  await rm(base, { recursive: true, force: true });
}
