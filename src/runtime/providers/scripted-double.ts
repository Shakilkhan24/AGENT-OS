/**
 * M3b — scripted provider double.
 *
 * The double is an in-process TypeScript class that mimics the wire shape
 * of a real provider adapter. The orchestrator imports only the port
 * (`ProviderAdapter`) and the registry picks this implementation when
 * `MINIMAL_PROVIDER_KIND === "scripted"`. Tests use it directly to avoid
 * a real subprocess.
 *
 * Wire shape: the double emits line-delimited JSON envelopes on its
 * `lifecycle` EventEmitter:
 *   {"kind":"started","at":"…"}
 *   {"kind":"output","bytes":N,"seq":S}
 *   {"kind":"ack","seq":S}
 *   {"kind":"exit","at":"…","code":N,"signal":null}
 *
 * stdin is a `Writable`-style facade: `write()` returns a promise that
 * resolves once the bytes have been queued (and backpressures past 4 MiB,
 * matching the native runner). The double does **not** interpret the bytes —
 * it just echoes them back as `output` events so the orchestrator's
 * observation pipeline is exercised end-to-end.
 *
 * Deterministic mode (the default): the double emits one `output` event
 * per stdin write and exits cleanly after the caller closes stdin. Tests
 * can override `scriptedResponse` to inject custom behaviour (errors,
 * disconnect, duplicate payloads, etc.).
 */
import { EventEmitter } from "node:events";
import type { AdapterCapabilities, ProviderAdapter, ProviderHandle, SpawnRequest } from "./adapter";

/** Maximum stdin queue depth — matches `main/pty-attachment.ts:61`. */
export const SCRIPTED_INPUT_CAP_BYTES = 4 * 1024 * 1024;

export interface ScriptedProviderOptions {
  /** Capability snapshot returned by `capabilities()`. */
  readonly capabilities?: AdapterCapabilities;
  /**
   * Hook to customise the response: called once per stdin write. Return an
   * array of `{ bytes }` entries to emit as `output` events. The default
   * echoes the bytes back so the orchestrator's observation pipeline is
   * exercised.
   */
  readonly scriptedResponse?: (request: SpawnRequest, bytes: Uint8Array) => Array<{ bytes: number }>;
  /** Force the lifecycle to emit `disconnect` instead of `exit` (tests M3b.3 path). */
  readonly disconnectOnFirstWrite?: boolean;
}

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  provider: "claude",
  version: "0.0.0-scripted",
  featureCount: 5,
  probedAt: new Date(0).toISOString(),
};

export class ScriptedProviderDouble implements ProviderAdapter {
  readonly kind = "scripted" as const;
  private readonly capabilitiesSnapshot: AdapterCapabilities;

  constructor(private readonly options: ScriptedProviderOptions = {}) {
    this.capabilitiesSnapshot = options.capabilities ?? DEFAULT_CAPABILITIES;
  }

  async capabilities(): Promise<AdapterCapabilities> {
    // Refresh the probe timestamp per call so the orchestrator can audit
    // when the capability snapshot was taken (matches the real probe).
    return { ...this.capabilitiesSnapshot, probedAt: new Date().toISOString() };
  }

  async spawn(req: SpawnRequest): Promise<ProviderHandle> {
    const lifecycle = new EventEmitter();
    let closed = false;
    let queued = 0;
    let seq = 0;
    let exited = false;
    const acked = new Set<number>();

    function ensureOpen(): void {
      if (closed) throw new Error("Provider handle is closed");
    }

    function emit(event: import("./adapter").LifecycleEvent): void {
      if (exited) return;
      lifecycle.emit("event", event);
    }

    function exit(code: number | null, signal: NodeJS.Signals | null): void {
      if (exited) return;
      exited = true;
      lifecycle.emit("event", { kind: "exit", at: new Date().toISOString(), code, signal });
    }

    // The handle's existence is the started signal — `startup` is filled
    // synchronously below. EventEmitter does not replay past events, so
    // emitting `started` synchronously before returning the handle would
    // race against the consumer's `lifecycle.on("event", …)` subscription.
    // The native runner in Increment 3 emits `started` because its pid
    // confirmation is genuinely async (subprocess spawn); the scripted
    // double has no such latency to bridge.

    if (this.options.disconnectOnFirstWrite) {
      // Force the orchestrator's `markAmbiguous` path: emit exit with code
      // null (no clean shutdown) and never ack. The double intentionally
      // does not call `exit()` so the orchestrator must surface uncertainty.
      //
      // Defer with `setImmediate` (not `queueMicrotask`): microtasks fire
      // before the caller's `lifecycle.on("event", …)` subscription lands,
      // so the exit would be silently dropped. setImmediate runs after
      // the synchronous post-await code that attaches the listener.
      setImmediate(() => {
        if (!exited) exit(null, "SIGPIPE");
      });
    }

    return {
      correlationId: req.correlationId,
      lifecycle,
      startup: { kind: "scripted-double", correlationId: req.correlationId },
      stdin: {
        write: async (bytes: Uint8Array) => {
          ensureOpen();
          queued += bytes.byteLength;
          if (queued > SCRIPTED_INPUT_CAP_BYTES)
            throw new Error(`Provider input busy: ${queued} bytes queued (cap ${SCRIPTED_INPUT_CAP_BYTES})`);
          // The default response echoes the bytes; custom scripts may override.
          const fragments = this.options.scriptedResponse
            ? this.options.scriptedResponse(req, bytes)
            : [{ bytes: bytes.byteLength }];
          for (const fragment of fragments) {
            seq += 1;
            emit({ kind: "output", bytes: fragment.bytes, seq });
          }
        },
        close: () => {
          if (closed) return;
          closed = true;
          queued = 0;
          // Only emit a clean exit if the double has not already been
          // disconnected — otherwise the disconnect path wins.
          if (!exited) exit(0, null);
        },
      },
      acknowledge: (bytes: number) => {
        // Acknowledge the highest still-unacked sequence so the runtime can
        // free its backpressure window. `bytes` is the byte count the
        // runtime is freeing; we translate it into an `ack` for the next
        // unacked output frame.
        let remaining = bytes;
        for (let s = 1; s <= seq && remaining > 0; s += 1) {
          if (acked.has(s)) continue;
          acked.add(s);
          remaining -= 1;
          lifecycle.emit("event", { kind: "ack", seq: s });
        }
      },
      exit: async (reason: string) => {
        void reason;
        exit(null, null);
        closed = true;
      },
    };
  }
}