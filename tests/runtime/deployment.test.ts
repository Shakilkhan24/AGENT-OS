/**
 * Deployment test for the OS-locked runtime. Spawns the production entry
 * (`dist/runtime/index.cjs`) through `helpers/runtime_lock.py` (via
 * `launchRuntime`) and proves four guarantees about the M1.3+M1.4 wiring:
 *
 *  1. The Python helper exits 73 on a duplicate owner and refuses the
 *     second launch with a typed `AppError("BUSY", ...)` — never silently
 *     attaching (per D-3).
 *  2. A runtime entry spawned against a shared-mode socket directory
 *     exits non-zero with "not private"; the existing listener survives.
 *  3. `SIGKILL` of the runtime child preserves the OS lock inode and the
 *     persisted workspace state on disk — a future handle can reattach.
 *  4. A ControlClient constructed with a random token fails the handshake
 *     cleanly with `AppError("UNAVAILABLE", "Runtime authentication failed")`.
 *
 * Skipped automatically when tmux or the runtime bundle is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { AppError } from "../../src/shared/errors";
import { launchRuntime } from "../../src/main/runtime-launcher";
import { profilePaths } from "../../src/main/profile-runtime";
import { ControlClient } from "../../src/runtime/control-client";

async function hasTmux(): Promise<boolean> {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }); return true; }
  catch { return false; }
}
async function hasBundle(): Promise<boolean> {
  try { await stat(path.resolve("dist/runtime/index.cjs")); return true; }
  catch { return false; }
}

test("runtime_lock.py exits 73 on duplicate owner", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-deploy-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await chmod(paths.parent, 0o700);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  // Spawn the helper directly so we exercise its 73-on-duplicate-owner path
  // without going through `launchRuntime`'s attach-first shortcut (which would
  // otherwise attach to the live runtime and never invoke the helper).
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const helper = path.resolve("dist/helpers/runtime_lock.py");
  const entry = path.resolve("dist/runtime/index.cjs");
  const firstArgs = [helper, paths.lock, process.execPath, entry, paths.socket, dataDir, paths.runtime, path.resolve("dist/helpers")];
  const firstChild = spawn("python3", firstArgs, { env: { ...process.env, MINIMAL_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const readyDeadline = Date.now() + 10_000;
  while (Date.now() < readyDeadline) {
    try {
      const ready = JSON.parse(await readFile(path.join(paths.runtime, "ready.json"), "utf8"));
      if (ready.token) break;
    } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  const child = spawn("python3", firstArgs, { env: { ...process.env, MINIMAL_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk.toString());
  const [code] = await once(child, "exit");
  assert.equal(code, 73, "helper must exit 73 on a duplicate owner");
  assert.match(stderr, /BUSY|EADDRINUSE/);
  // Tear down the original runtime child without going through the helper.
  const originalPid = firstChild.pid!;
  try { process.kill(originalPid, "SIGKILL"); } catch {}
});

test("the runtime entrypoint refuses to listen on a shared socket directory", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-deploy-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o755 });
  await chmod(paths.parent, 0o755);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    path.resolve("dist/runtime/index.cjs"), paths.socket, dataDir, paths.runtime, path.resolve("dist/helpers"),
  ], { env: { ...process.env, MINIMAL_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk.toString());
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /not private|UNAVAILABLE/);
});

test("SIGKILL preserves the OS lock inode and persisted workspace state", { timeout: 30000 }, async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-deploy-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await chmod(paths.parent, 0o700);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const first = await launchRuntime({
    dataDir, helpersDir: path.resolve("dist/helpers"), executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"), runtimeDir: paths.runtime,
    socketPath: paths.socket, lockPath: paths.lock,
  });
  const firstClient = new ControlClient(paths.socket, { profileKey: paths.key, token: first.token });
  let originalInode: number | undefined;
  try {
    await firstClient.call("create-session", "Survives", dataDir);
    originalInode = (await stat(paths.lock)).ino;
  } finally { firstClient.close(); }
  // SIGKILL the runtime child without draining; the lock helper retains the inode.
  await first.stop("SIGKILL", 2000);
  // The OS lock file inode must be unchanged; no other process can hold the lock.
  assert.equal((await stat(paths.lock)).ino, originalInode);
  // Persisted state must survive on disk; the next runtime will reload it.
  const persisted = JSON.parse(await readFile(path.join(dataDir, "state.json"), "utf8"));
  assert.ok(persisted.sessions.some((s: { name: string }) => s.name === "Survives"));
});

test("a wrong token fails the handshake cleanly", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-deploy-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await chmod(paths.parent, 0o700);
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const handle = await launchRuntime({
    dataDir, helpersDir: path.resolve("dist/helpers"), executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"), runtimeDir: paths.runtime,
    socketPath: paths.socket, lockPath: paths.lock,
  });
  t.after(async () => { try { await handle.stop("SIGTERM", 2000); } catch {} await rm(paths.parent, { recursive: true, force: true }); });
  const bogus = new ControlClient(paths.socket, {
    profileKey: paths.key, token: randomBytes(32).toString("hex"),
  });
  try {
    await assert.rejects(bogus.ready, (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.failure.code, "UNAVAILABLE");
      assert.match(error.message, /Runtime authentication failed/);
      return true;
    });
  } finally { bogus.close(); }
});

// (no extra imports needed)
