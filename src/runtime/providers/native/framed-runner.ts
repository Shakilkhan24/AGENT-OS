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
  const child: ChildProcessWithoutNullStreams = spawn(
    binary,
    [...args],
    { stdio: "pipe" },
  );
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

  return {
    correlationId: req.correlationId,
    lifecycle,
    startup,
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

// `DEFAULT_TIMEOUT_MS` is reserved for the run-level deadline policy in
// Increment 4 (cross-run cancellation); the runner itself does not
// enforce it so a long-running observation can stream.
void DEFAULT_TIMEOUT_MS;