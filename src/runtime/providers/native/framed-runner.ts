/**
 * M3b.3 — native framed runner.
 *
 * Spawns a native provider adapter as a child process with stdio:
 * "pipe", wraps stdout in a `FrameDecoder`, and surfaces lifecycle
 * events through the same `ProviderHandle` shape as the scripted double
 * (`runtime/providers/scripted-double.ts`). stdin is bounded by the
 * `BudgetedWriter` from `runtime/orchestration/back-pressure.ts`.
 *
 * Wire shape (length-prefixed JSON frames, matching `framing.ts`):
 *   - Inbound (adapter → runtime): `{ kind: "started" | "output" | "exit", … }`
 *   - Outbound (runtime → adapter): `{ kind: "input" | "ack" | "exit", … }`
 *
 * The runner is the canonical spawn pattern from
 * `src/main/pty-attachment.ts:7-96` extracted and narrowed so the
 * orchestrator can reuse it without coupling to the renderer's wiring.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ProviderHandle, SpawnRequest } from "../adapter";
import { translateProviderConfig, type ProviderConfig } from "../config-translator";
import { FrameDecoder, encodeFrame } from "../../../runtime/framing";
import { createBudgetedWriter, INPUT_CAP } from "../../../runtime/orchestration/back-pressure";
import { AppError } from "../../../shared/errors";
import { MAX_FRAME_BYTES } from "../../../shared/protocol";

const DEFAULT_TIMEOUT_MS = 30_000;

export interface FramedRunnerOptions {
  /** Frame size limit. Default matches the runtime's MAX_FRAME_BYTES. */
  readonly frameLimit?: number;
  /**
   * Optional override: run the adapter as a child of `command[0]` with
   * the supplied args (used by tests so the in-repo stub can be run
   * via `node` instead of being a real binary). When omitted, the
   * adapter path itself is the binary.
   */
  readonly command?: { readonly binary: string; readonly args: readonly string[] };
  /**
   * M4.5: provider-native configuration translation. When
   * supplied, the runner calls `translateProviderConfig` and
   * appends the translated argv + env + cwd to the spawn call.
   * Translation failures exit the child with code 1 and emit a
   * structured error event.
   */
  readonly providerProfile?: ProviderConfig;
}

/**
 * Spawn the adapter at `adapterPath` and return a `ProviderHandle`
 * whose lifecycle streams follow the runtime framing protocol. The
 * caller is responsible for closing the handle (and acknowledging the
 * frames it consumes).
 */
export async function spawnFramedRunner(
  adapterPath: string,
  req: SpawnRequest,
  options: FramedRunnerOptions = {},
): Promise<ProviderHandle> {
  const limit = options.frameLimit ?? MAX_FRAME_BYTES;
  const binary = options.command?.binary ?? adapterPath;
  const args: readonly string[] = options.command?.args
    ?? [adapterPath, "--correlation-id", req.correlationId, "--deadline-at", req.deadlineAt];

  // M4.5: translate provider-native config into argv tail + env +
  // cwd. The translator is pure and throws `INVALID_REQUEST` on
  // bad config; we catch the failure here, emit a structured
  // error event, and exit with code 1 so the orchestrator sees a
  // missing-started-frame signal.
  if (options.providerProfile !== undefined) {
    try {
      // The runner is provider-agnostic; the provider kind is
      // encoded in `SpawnRequest.providerVersion` (`"claude@..."`
      // / `"codex@..."` form is the convention used elsewhere).
      // For M4.5 the adapter factories translate before calling
      // the runner; the runner-level `providerProfile` field is
      // the legacy/edge path that ships with a known provider
      // triple. Callers that need provider-aware translation
      // should compute it themselves and pass via `command.args`.
      const translated = translateProviderConfig({
        provider: "claude",
        providerVersion: req.providerVersion,
        model: req.model,
        accountMode: req.accountMode,
        config: options.providerProfile,
      });
      const finalArgs: string[] = [...args, ...translated.argv];
      const finalEnv: NodeJS.ProcessEnv = {
        ...process.env,
        ...translated.env,
      };
      const child: ChildProcessWithoutNullStreams = spawn(
        binary,
        finalArgs,
        {
          stdio: "pipe",
          env: finalEnv,
          ...(translated.cwd ? { cwd: translated.cwd } : {}),
        },
      );
      return wireChild(child, req, limit, options);
    } catch (error) {
      const appErr = error instanceof AppError
        ? error
        : new AppError(
            "INVALID_REQUEST",
            `Provider config translation failed: ${error instanceof Error ? error.message : String(error)}`,
          );
      const lifecycle = new EventEmitter();
      // Defer the emit to a macrotask so callers attaching
      // listeners immediately after `await spawnFramedRunner(...)`
      // still receive the error. A microtask fires before the
      // caller's `await` resumes, so the listener would attach too
      // late; `setImmediate` runs after the current microtask
      // queue drains, which is the right ordering for "emit
      // before the next caller-observable callback".
      setImmediate(() => {
        lifecycle.emit("error", appErr);
      });
      return {
        correlationId: req.correlationId,
        lifecycle,
        startup: { kind: "native-framed", correlationId: req.correlationId, translationError: appErr.failure.code },
        stdin: { write: async () => { throw appErr; }, close: () => { /* nothing to close */ } },
        acknowledge: () => { /* nothing to ack */ },
        exit: async () => { /* no child */ },
      };
    }
  }

  const child: ChildProcessWithoutNullStreams = spawn(
    binary,
    [...args],
    { stdio: "pipe" },
  );
  return wireChild(child, req, limit, options);
}

/**
 * Wire the spawned child into the lifecycle/decoder pipeline.
 * Extracted from `spawnFramedRunner` so the M4.5 translation
 * branch can share the same plumbing as the default branch.
 */
function wireChild(
  child: ChildProcessWithoutNullStreams,
  req: SpawnRequest,
  limit: number,
  options: FramedRunnerOptions,
): ProviderHandle {
  void limit;
  void options;
  const lifecycle = new EventEmitter();
  let closed = false;
  let exited = false;
  let seq = 0;
  let bytesSeen = 0;
  function ensureOpen(): void {
    if (closed) throw new AppError("UNAVAILABLE", "Provider handle is closed");
  }
  function emit(event: import("../adapter").LifecycleEvent): void {
    if (exited) return;
    lifecycle.emit("event", event);
  }
  function exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (exited) return;
    exited = true;
    lifecycle.emit("event", { kind: "exit", at: new Date().toISOString(), code, signal });
  }

  const writer = createBudgetedWriter({
    pause: () => { child.stdout.pause(); },
    resume: () => { child.stdout.resume(); },
  });

  // M4.1: a mutable startup envelope that the started-frame handler
  // can populate with adapter-supplied metadata (e.g. `scheme: "codex"`,
  // `bidirectionalInput: false`). The default mirrors the previous
  // shape; the started-frame handler merges in `metadata` when present.
  const startup: Record<string, unknown> = { kind: "native-framed", correlationId: req.correlationId };

  const decoder = new FrameDecoder((value: unknown) => {
    if (!value || typeof value !== "object") return;
    const v = value as Record<string, unknown>;
    if (v.kind === "started") {
      emit({ kind: "started", at: String(v.at ?? new Date().toISOString()) });
      // M4.1: surface the adapter's startup metadata (e.g. codex
      // declares `scheme: "codex"` and `bidirectionalInput: false`).
      // The Claude stub does not emit metadata, so this stays `null`
      // for the existing path — no breaking change.
      if (v.metadata && typeof v.metadata === "object") {
        (startup as Record<string, unknown>).metadata = v.metadata;
      }
      return;
    }
    if (v.kind === "output") {
      seq += 1;
      const bytes = Number(v.bytes ?? 0);
      bytesSeen += bytes;
      emit({ kind: "output", bytes, seq });
      writer.deliver(bytes);
      return;
    }
    if (v.kind === "exit") {
      const code = v.code == null ? null : Number(v.code);
      const signal = v.signal == null ? null : String(v.signal) as NodeJS.Signals;
      exit(code, signal);
      return;
    }
  }, () => limit);

  child.stdout.on("data", (chunk: Buffer) => {
    try { decoder.push(chunk); }
    catch (error) {
      exit(null, null);
      handleClose();
      const message = error instanceof Error ? error.message : String(error);
      lifecycle.emit("error", new AppError("INVALID_REQUEST", `Framed runner decoder failed: ${message}`));
    }
  });
  child.stderr.on("data", (data: Buffer) => {
    // Surface stderr to the lifecycle as a structured error so a higher
    // observer can audit it. The bytes are NOT forwarded into stdout —
    // they are a side channel for diagnostics only.
    lifecycle.emit("stderr", data.toString("utf8"));
  });
  child.on("error", (error) => {
    if (!exited) exit(null, null);
    lifecycle.emit("error", new AppError("UNAVAILABLE", `Framed runner child error: ${error.message}`));
  });
  child.on("exit", (code, signal) => {
    if (!exited) exit(code, signal);
    handleClose();
  });

  function handleClose(): void {
    if (closed) return;
    closed = true;
    try { child.stdin.end(); } catch { /* already closed */ }
    try { child.stdout.destroy(); } catch { /* already destroyed */ }
  }

  // M5.3 — capture OS-level identity at spawn time. `pid` is
  // always populated when the runner successfully spawns a
  // child; `pgid` is captured only when the platform exposes
  // the process-group id (typically Linux + `setpgid`). The
  // observation level is `"fully-observed"` only when both
  // pid AND pgid were captured; otherwise it falls back to
  // `"pid-only"`. The whole `nativeProcess` block is omitted
  // when no pid is available (e.g. spawn returned an unusable
  // handle) — additive, existing callers can ignore it.
  const nativeProcess = captureNativeProcess(child);

  return {
    correlationId: req.correlationId,
    lifecycle,
    startup,
    ...(nativeProcess ? { nativeProcess } : {}),
    stdin: {
      write: async (bytes: Uint8Array) => {
        ensureOpen();
        if (bytes.byteLength > INPUT_CAP)
          throw new AppError("INVALID_REQUEST", `Native adapter input exceeds ${INPUT_CAP} bytes`);
        const frame = encodeFrame({ kind: "input", bytes: bytes.byteLength }, limit);
        return new Promise((resolve, reject) => {
          child.stdin.write(frame, (error) => {
            if (error) reject(new AppError("UNAVAILABLE", `Native adapter stdin closed: ${error.message}`));
            else resolve();
          });
        });
      },
      close: () => {
        if (closed) return;
        closed = true;
        try { child.stdin.end(); } catch { /* already closed */ }
        // Defer the exit so a final exit frame from the child can land.
        const exitTimer = setTimeout(() => {
          if (!exited) exit(0, null);
        }, 1_000);
        exitTimer.unref();
      },
    },
    acknowledge: (bytes: number) => {
      seq = Math.max(0, seq - bytes);
      writer.acknowledge(bytes);
    },
    exit: async (reason: string) => {
      void reason;
      if (exited) return;
      try { child.kill("SIGTERM"); } catch { /* already dead */ }
      exit(null, null);
      handleClose();
    },
  };
}

/**
 * M5.3 — capture pid / pgid / observation level at spawn time.
 * Returns `undefined` when no pid is available (defensive —
 * `ChildProcess.pid` is `number | undefined`).
 */
function captureNativeProcess(
  child: ChildProcessWithoutNullStreams,
): { readonly pid: number; readonly pgid: number | null; readonly observation: "fully-observed" | "pid-only" } | undefined {
  const pid = typeof child.pid === "number" ? child.pid : null;
  if (pid === null) return undefined;
  let pgid: number | null = null;
  try {
    if (process.platform === "linux" || process.platform === "darwin") {
      // `process.getuid` is a sync OS call that works on Linux/macOS.
      // Reading `/proc/<pid>/stat` field 5 (tpgid) is the reliable way
      // to read the process group of an arbitrary child pid. If the
      // file is missing (process exited between spawn and read) we
      // fall back to `pid-only`. The read is bounded to one tiny file.
      try {
        const fs = require("node:fs") as typeof import("node:fs");
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8") as string;
        // Format documented in proc(5): field 5 is `tpgid`.
        // The pid field itself is field 1 and is parenthesised
        // (`(COMMAND)`) — split on the LAST `)` to skip past the
        // command name even when it contains spaces or parens.
        const closeParen = stat.lastIndexOf(")");
        if (closeParen !== -1) {
          const tail = stat.slice(closeParen + 2);
          const fields = tail.split(" ");
          // tail[0] = state, tail[1] = ppid, tail[2] = pgrp, tail[3] = session.
          const pgrp = Number(fields[2]);
          if (Number.isFinite(pgrp) && pgrp > 0) pgid = pgrp;
        }
      } catch {
        // /proc not available (non-Linux) or process gone — fall back.
      }
    }
  } catch {
    pgid = null;
  }
  return { pid, pgid, observation: pgid === null ? "pid-only" : "fully-observed" };
}

// `DEFAULT_TIMEOUT_MS` is reserved for the run-level deadline policy in
// Increment 4 (cross-run cancellation); the runner itself does not
// enforce it so a long-running observation can stream.
void DEFAULT_TIMEOUT_MS;