/**
 * End-to-end test for the runtime child entrypoint (M1.3+M1.4).
 *
 * Spawns `dist/runtime/index.cjs` as a child process and proves:
 *  - ready.json appears within the readiness budget
 *  - a ControlClient constructed from the embedded token reaches hello() and matches
 *    the readiness incarnation/appVersion
 *  - the socket directory validation rejects shared parent dirs
 *  - SIGTERM closes the listener and removes ready.json
 *
 * Skipped automatically when tmux or the runtime bundle is missing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { profilePaths } from "../../src/main/profile-runtime";
import { ControlClient } from "../../src/runtime/control-client";

const READY_BUDGET_MS = 10_000;

async function hasTmux(): Promise<boolean> {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore", timeout: 5000 }); return true; }
  catch { return false; }
}
async function hasBundle(): Promise<boolean> {
  try { await access(path.resolve("dist/runtime/index.cjs")); return true; }
  catch { return false; }
}

async function spawnRuntime(parentDir: string, helpersDir: string) {
  const dataDir = await mkdtemp(path.join(parentDir, "minimal-runtime-entry-data-"));
  const paths = profilePaths(dataDir);
  const runtimeDir = `${paths.parent}/${paths.key}`;
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const child = spawn(process.execPath, [
    path.resolve("dist/runtime/index.cjs"), paths.socket, dataDir, runtimeDir, helpersDir,
  ], { env: { ...process.env, MINIMAL_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
  const stderr: Buffer[] = [];
  child.stderr.on("data", chunk => stderr.push(chunk));
  const readyPath = path.join(runtimeDir, "ready.json");
  const start = Date.now();
  let ready: { token: string; incarnation: string; socket: string; appVersion: string; pid: number } | undefined;
  while (Date.now() - start < READY_BUDGET_MS) {
    try { ready = JSON.parse(await readFile(readyPath, "utf8")); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  return { child, ready, stderr: Buffer.concat(stderr).toString("utf8"), paths, readyPath };
}

test("runtime entrypoint serves ready.json and a valid ControlClient handshake", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-runtime-entry-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await spawnRuntime(parent, path.resolve("dist/helpers"));
  t.after(async () => {
    if (!handle.child.killed) handle.child.kill("SIGTERM");
    await once(handle.child, "exit").catch(() => {});
  });
  if (!handle.ready) {
    handle.child.kill("SIGKILL");
    throw new Error(`runtime entry did not write ready.json in ${READY_BUDGET_MS} ms\nstderr: ${handle.stderr}`);
  }
  assert.match(handle.ready.token, /^[a-f0-9]{64}$/);
  assert.equal(handle.ready.socket, handle.paths.socket);
  const client = new ControlClient(handle.paths.socket, { profileKey: handle.paths.key, token: handle.ready.token });
  try {
    const welcome = await client.ready;
    assert.equal(welcome.incarnation, handle.ready!.incarnation);
    assert.equal(welcome.appVersion, handle.ready!.appVersion);
    const hello = await client.call("hello");
    assert.equal(hello.incarnation, handle.ready!.incarnation);
  } finally { client.close(); }
});

test("runtime entrypoint refuses to start when the socket directory is shared", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-runtime-entry-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const dataDir = await mkdtemp(path.join(parent, "data-"));
  const paths = profilePaths(dataDir);
  const runtimeDir = `${paths.parent}/${paths.key}`;
  await mkdir(paths.parent, { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  await chmod(paths.parent, 0o755);
  t.after(() => chmod(paths.parent, 0o700).catch(() => {}));
  const child = spawn(process.execPath, [
    path.resolve("dist/runtime/index.cjs"), paths.socket, dataDir, runtimeDir, path.resolve("dist/helpers"),
  ], { env: { ...process.env, MINIMAL_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk.toString());
  const [code] = await once(child, "exit");
  assert.notEqual(code, 0);
  assert.match(stderr, /not private|UNAVAILABLE/);
});

test("runtime entrypoint removes ready.json on SIGTERM", async t => {
  if (!await hasTmux()) { t.skip("tmux not installed"); return; }
  if (!await hasBundle()) { t.skip("dist/runtime/index.cjs missing — run `npm run build` first"); return; }
  const parent = await mkdtemp(path.join(tmpdir(), "minimal-runtime-entry-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await spawnRuntime(parent, path.resolve("dist/helpers"));
  t.after(async () => { try { await rm(handle.paths.parent, { recursive: true, force: true }); } catch {} });
  if (!handle.ready) {
    handle.child.kill("SIGKILL");
    throw new Error("runtime entry did not become ready");
  }
  handle.child.kill("SIGTERM");
  await once(handle.child, "exit");
  await assert.rejects(stat(handle.readyPath));
});