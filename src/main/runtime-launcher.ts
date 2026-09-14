/**
 * Spawns the runtime child process behind `helpers/runtime_lock.py` and returns
 * a handle the desktop uses to connect via `ControlClient`. Encapsulates the
 * `python3 <helper> <lock> <exec> <runtime-entry> ...` invocation, polls
 * `ready.json`, and exposes a `stop()` that signals the child and escalates
 * to SIGKILL on budget exhaustion.
 *
 * M1.6 split: when a runtime is already serving this profile (per the per-profile
 * lock inode and the durable `ready.json` written by the entrypoint),
 * `launchRuntime` returns a *detached* handle bound to that existing runtime
 * instead of spawning a new child. The desktop then only closes its authenticated
 * socket on window close; the runtime and tmux work survive. To actually stop
 * the runtime and its durable work, the user must invoke `stop-runtime`
 * explicitly; `stop()` on a detached handle is a no-op.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppError } from "../shared/errors";
import { ControlClient } from "../runtime/control-client";
import { createPrivateLockFile } from "./profile-runtime";

const READY_BUDGET_MS = 10_000;
const READY_POLL_MS = 100;

export interface RuntimeLaunchOptions {
  /** Path to the userData directory (passed as argv + MINIMAL_DATA_DIR env). */
  dataDir: string;
  /** Absolute path to the helpers directory containing `runtime_lock.py`. */
  helpersDir: string;
  /** Absolute path to the Electron binary (or `process.execPath`). */
  executable: string;
  /** Absolute path to `dist/runtime/index.cjs`. */
  runtimeEntry: string;
  /** Per-profile runtime directory `${parent}/${key}`. */
  runtimeDir: string;
  /** Per-profile socket path `${parent}/${key}.sock`. */
  socketPath: string;
  /** Per-profile lock path `${parent}/${key}.lock`. */
  lockPath: string;
  /** Extra env merged on top of `process.env` for the child. */
  env?: NodeJS.ProcessEnv;
  /** Poll interval override; defaults to 100 ms. */
  pollMs?: number;
  /** Override the readiness budget; defaults to 10 s. */
  readyBudgetMs?: number;
}

export interface RuntimeHandle {
  readonly pid: number;
  readonly token: string;
  readonly incarnation: string;
  readonly socketPath: string;
  readonly lockPath: string;
  readonly runtimeDir: string;
  /**
   * Send a signal to the runtime and wait up to `budgetMs` for it to exit.
   * Escalates to SIGKILL on budget exhaustion. On a detached (attached) handle
   * the call is a no-op so a window-close path cannot accidentally terminate
   * a runtime owned by another launcher.
   */
  stop(signal: "SIGTERM" | "SIGKILL", budgetMs: number): Promise<void>;
  /**
   * Detach the ownership of the child: stop will no longer kill it.
   * Useful when handing the runtime off to a different launcher.
   */
  detach(): void;
  /** True when this handle was produced by `tryAttachRuntime`; the launcher did not spawn the child. */
  readonly attached?: boolean;
}

/** Parse the JSON error written by the runtime_lock helper or the entry on stderr. */
function parseStderrError(stderr: string): { code: "BUSY" | "EADDRINUSE" | "UNAVAILABLE"; message: string } | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line) as { code?: string; message?: string };
      if (value && (value.code === "BUSY" || value.code === "EADDRINUSE" || value.code === "UNAVAILABLE"))
        return { code: value.code, message: value.message ?? "" };
    } catch { /* not JSON; skip */ }
  }
  return undefined;
}

export async function launchRuntime(options: RuntimeLaunchOptions): Promise<RuntimeHandle> {
  const { dataDir, helpersDir, executable, runtimeEntry, runtimeDir, socketPath, lockPath } = options;
  await createPrivateLockFile(lockPath);
  // M1.6: if a runtime is already serving this profile, attach to it instead
  // of spawning a duplicate. The launcher returns a detached handle so window
  // close does not become an implicit runtime stop.
  const attached = await tryAttachRuntime({ socketPath, runtimeDir });
  if (attached) return attached;
  // Clear any stale ready.json so a previous crash cannot be misread as fresh.
  await rm(path.join(runtimeDir, "ready.json"), { force: true });
  const helper = path.join(helpersDir, "runtime_lock.py");
  const args = [helper, lockPath, executable, runtimeEntry, socketPath, dataDir, runtimeDir, helpersDir];
  const child: ChildProcessByStdio<null, Readable, Readable> = spawn("python3", args, {
    env: { ...process.env, MINIMAL_DATA_DIR: dataDir, ELECTRON_RUN_AS_NODE: "1", ...(options.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on("data", chunk => stderrChunks.push(chunk));
  child.stdout.on("data", () => {});
  child.once("error", () => {});
  const readyPath = path.join(runtimeDir, "ready.json");
  const budget = options.readyBudgetMs ?? READY_BUDGET_MS;
  const poll = options.pollMs ?? READY_POLL_MS;
  const deadline = Date.now() + budget;
  let ready: { token: string; incarnation: string; socket: string; appVersion: string; pid: number } | undefined;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    try {
      ready = JSON.parse(await readFile(readyPath, "utf8"));
      break;
    } catch { await new Promise(resolve => setTimeout(resolve, poll)); }
  }
  if (!ready) {
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const parsed = parseStderrError(stderr);
    if (parsed?.code === "BUSY") throw new AppError("BUSY", parsed.message || "A runtime already owns this profile");
    if (parsed?.code === "EADDRINUSE") throw new AppError("CONFLICT", parsed.message || "Runtime socket is already in use");
    throw new AppError("UNAVAILABLE", parsed?.message || `Runtime did not become ready in ${budget} ms: ${stderr || "no stderr"}`);
  }
  let detached = false;
  let exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const handle: RuntimeHandle = {
    pid: child.pid!,
    token: ready.token,
    incarnation: ready.incarnation,
    socketPath,
    lockPath,
    runtimeDir,
    async stop(signal, budgetMs) {
      if (detached) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill(signal);
      const start = Date.now();
      while (Date.now() - start < budgetMs) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
    detach() {
      detached = true;
      // Release the listener so we don't keep the event loop alive on the child.
      child.stderr.removeAllListeners("data");
      child.stdout.removeAllListeners("data");
    },
  };
  // Surface unexpected exits to callers via a hidden property. The desktop's
  // flushBeforeQuit can `await handle.stop(...)` regardless; this is informational.
  void exitPromise.then(({ code, signal }) => {
    if (!detached && (code !== 0 && code !== null)) {
      // Stash on the handle for callers to inspect without changing the public surface.
      (handle as RuntimeHandle & { unexpectedExit?: { code: number | null; signal: NodeJS.Signals | null } }).unexpectedExit = { code, signal };
    }
  });
  return handle;
}

/** Resolve the bundled runtime entrypoint and helper path for the desktop process. */
export interface RuntimePaths {
  helper: string;
  runtimeEntry: string;
  executable: string;
}

export function resolveRuntimePaths(helpersDir: string, distRoot: string, executable = process.execPath): RuntimePaths {
  return {
    helper: path.join(helpersDir, "runtime_lock.py"),
    runtimeEntry: path.join(distRoot, "runtime", "index.cjs"),
    executable,
  };
}

/**
 * Connect to an already-running runtime serving this profile. Returns a
 * detached handle on success, or `undefined` when no live runtime owns the
 * profile (the desktop should then `launchRuntime(...)` to spawn a fresh
 * child). The handshake is the source of truth: a stale `ready.json` from a
 * crashed runtime is rejected before it can convince the desktop to attach.
 */
export async function tryAttachRuntime(args: {
  socketPath: string;
  runtimeDir: string;
  /** Optional profileKey override; defaults to deriving from runtimeDir. */
  profileKey?: string;
}): Promise<RuntimeHandle | undefined> {
  const readyPath = path.join(args.runtimeDir, "ready.json");
  let ready: { token: string; incarnation: string; socket: string; appVersion: string; pid: number };
  try { ready = JSON.parse(await readFile(readyPath, "utf8")); }
  catch { return undefined; } // No ready.json: nothing is listening for this profile.
  if (!ready.token || !ready.socket || ready.socket !== args.socketPath) return undefined;
  const profileKey = args.profileKey ?? path.basename(args.socketPath, ".sock");
  const client = new ControlClient(args.socketPath, { profileKey, token: ready.token }, () => {}, () => {
    try { client.close(); } catch { /* already gone */ }
  }, 1500);
  try {
    const welcome = await client.ready;
    if (welcome.incarnation !== ready.incarnation) { client.close(); return undefined; }
    return {
      pid: ready.pid ?? -1,
      token: ready.token,
      incarnation: ready.incarnation,
      socketPath: args.socketPath,
      lockPath: path.join(path.dirname(args.socketPath), `${profileKey}.lock`),
      runtimeDir: args.runtimeDir,
      // Detached: the desktop does not own the child. Calling stop() is a no-op
      // so a window-close path that forgets to opt out cannot accidentally
      // signal the live runtime. `stopRuntime` must be invoked explicitly.
      async stop() { client.close(); },
      detach() { client.close(); },
      attached: true,
    };
  } catch {
    try { client.close(); } catch { /* already gone */ }
    return undefined;
  }
}

/** Convenience: ensure the per-profile runtime dir exists with the right mode. */
export async function ensureRuntimeDir(runtimeDir: string) {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(runtimeDir), { recursive: true, mode: 0o700 });
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const info = await stat(runtimeDir);
  if (!info.isDirectory()) throw new AppError("UNAVAILABLE", "Runtime dir is not a directory");
}

/** Build the standard `${parent}/${key}` runtime dir for the given dataDir. */
export async function standardRuntimeDir(dataDir: string) {
  const tmp = await mkdtemp(path.join(tmpdir(), "minimal-rtmeta-"));
  await rm(tmp, { recursive: true, force: true });
  const { profilePaths } = await import("./profile-runtime");
  const paths = profilePaths(dataDir);
  return { paths, runtimeDir: paths.runtime };
}