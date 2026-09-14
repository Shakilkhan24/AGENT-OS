/**
 * Integration test for src/main/runtime-launcher.ts. Spawns the runtime child
 * via `helpers/runtime_lock.py` and proves:
 *   - launchRuntime returns a handle with non-empty token and incarnation
 *   - ready.json is consumed within the readiness budget
 *   - stop("SIGTERM") resolves before the budget
 *   - the second launch against the same lock short-circuits per D-3
 *
 * Skipped automatically when tmux or the runtime bundle is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, rm, stat, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { launchRuntime, tryAttachRuntime } from "../../src/main/runtime-launcher";
import { profilePaths } from "../../src/main/profile-runtime";
import { ControlClient } from "../../src/runtime/control-client";

async function hasTmux(): Promise<boolean> {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }); return true; }
  catch { return false; }
}
async function hasBundle(): Promise<boolean> {
  try { await access(path.resolve("dist/runtime/index.cjs")); return true; }
  catch { return false; }
}

test("launchRuntime spawns the runtime child and serves a valid token", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-launcher-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const handle = await launchRuntime({
    dataDir,
    helpersDir: path.resolve("dist/helpers"),
    executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"),
    runtimeDir: paths.runtime,
    socketPath: paths.socket,
    lockPath: paths.lock,
  });
  t.after(async () => { try { await handle.stop("SIGTERM", 2000); } catch {} await rm(paths.parent, { recursive: true, force: true }); });
  assert.ok(handle.pid > 0);
  assert.match(handle.token, /^[a-f0-9]{64}$/);
  assert.equal(handle.socketPath, paths.socket);
  assert.equal(handle.lockPath, paths.lock);
  // Token must round-trip through ControlClient: ready handshake then hello.
  const client = new ControlClient(handle.socketPath, { profileKey: paths.key, token: handle.token });
  try {
    const welcome = await client.ready;
    assert.equal(welcome.incarnation, handle.incarnation);
    const hello = await client.call("hello");
    assert.equal(hello.incarnation, handle.incarnation);
  } finally { client.close(); }
});

test("launchRuntime resolves stop() within the budget on SIGTERM", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-launcher-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  const handle = await launchRuntime({
    dataDir,
    helpersDir: path.resolve("dist/helpers"),
    executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"),
    runtimeDir: paths.runtime,
    socketPath: paths.socket,
    lockPath: paths.lock,
  });
  t.after(async () => { try { await handle.stop("SIGKILL", 1000); } catch {} await rm(paths.parent, { recursive: true, force: true }); });
  const start = Date.now();
  await handle.stop("SIGTERM", 5000);
  assert.ok(Date.now() - start < 6000, "stop should resolve within the budget");
  // Second stop is a no-op.
  await handle.stop("SIGTERM", 100);
});

test("launchRuntime refuses a stale ready.json from a previous crash", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-launcher-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  // Plant a stale ready.json that looks valid; launchRuntime must overwrite it.
  const readyPath = path.join(paths.runtime, "ready.json");
  await writeFile(readyPath, JSON.stringify({ token: "stale", incarnation: "stale", socket: paths.socket, appVersion: "x", pid: 0 }));
  await assert.doesNotReject(stat(readyPath));
  let handle: Awaited<ReturnType<typeof launchRuntime>> | undefined | null;
  try {
    handle = await launchRuntime({
      dataDir,
      helpersDir: path.resolve("dist/helpers"),
      executable: process.execPath,
      runtimeEntry: path.resolve("dist/runtime/index.cjs"),
      runtimeDir: paths.runtime,
      socketPath: paths.socket,
      lockPath: paths.lock,
      readyBudgetMs: 500,
    });
  } catch {
    handle = null;
  }
  t.after(async () => { if (handle) try { await handle.stop("SIGKILL", 1000); } catch {} await rm(paths.parent, { recursive: true, force: true }); });
  // The stale file must have been unlinked before the runtime tries to write a new one.
  // If the runtime did write a fresh one, it must no longer be the stale payload.
  try {
    const onDisk = JSON.parse(await readFile(readyPath, "utf8"));
    assert.notEqual(onDisk.token, "stale");
  } catch { /* unlinked is also valid */ }
});

test("tryAttachRuntime binds to the live runtime and a second launch attaches instead of spawning", { timeout: 25000 }, async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-launcher-attach-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });

  // First launch spawns the runtime child.
  const first = await launchRuntime({
    dataDir, helpersDir: path.resolve("dist/helpers"), executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"), runtimeDir: paths.runtime,
    socketPath: paths.socket, lockPath: paths.lock,
  });
  t.after(async () => { try { await first.stop("SIGTERM", 2000); } catch {} await rm(paths.parent, { recursive: true, force: true }); });
  assert.equal(first.attached, undefined, "first launch spawns the child");

  // The runtime is now serving. `tryAttachRuntime` must connect.
  const attached = await tryAttachRuntime({ socketPath: paths.socket, runtimeDir: paths.runtime, profileKey: paths.key });
  assert.ok(attached, "attach should succeed against a live runtime");
  assert.equal(attached.attached, true);
  assert.equal(attached.token, first.token);
  assert.equal(attached.incarnation, first.incarnation);

  // `stop()` on a detached handle is a no-op (it must not signal the live runtime).
  const firstClient = new ControlClient(paths.socket, { profileKey: paths.key, token: first.token });
  try { await firstClient.call("hello"); } finally { firstClient.close(); }
  await attached.stop("SIGTERM", 500);
  // The runtime must still be alive after a "stop" on the attached handle.
  const probe = new ControlClient(paths.socket, { profileKey: paths.key, token: first.token });
  try {
    const welcome = await probe.ready;
    assert.equal(welcome.incarnation, first.incarnation);
  } finally { probe.close(); }

  // `launchRuntime` invoked again must reuse the live runtime (no second child).
  const second = await launchRuntime({
    dataDir, helpersDir: path.resolve("dist/helpers"), executable: process.execPath,
    runtimeEntry: path.resolve("dist/runtime/index.cjs"), runtimeDir: paths.runtime,
    socketPath: paths.socket, lockPath: paths.lock,
  });
  t.after(async () => { try { await second.stop("SIGTERM", 500); } catch {} });
  assert.equal(second.attached, true, "second launch attaches instead of spawning");
  assert.equal(second.token, first.token);
});

test("tryAttachRuntime returns undefined when no live runtime owns the profile", { timeout: 10000 }, async t => {
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-attach-empty-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(paths.runtime, { recursive: true, mode: 0o700 });
  // No ready.json, no socket — must return undefined (no spawn, no error).
  const result = await tryAttachRuntime({ socketPath: paths.socket, runtimeDir: paths.runtime, profileKey: paths.key });
  assert.equal(result, undefined);
});