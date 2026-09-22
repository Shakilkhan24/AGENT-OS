/**
 * M4.1 — Codex scripted provider double.
 *
 * Parallel to `scripted-double.ts` but for the second supported
 * provider. The Codex adapter advertises a deliberately distinct
 * capability shape and event metadata:
 *
 *  - `provider: "codex"` (vs the Claude default in `scripted-double.ts`).
 *  - `featureCount: 4` (matching the codex slot in
 *    `capability-matrix.ts:64`).
 *  - `startup.kind = "codex-scripted-double"` (vs the Claude default's
 *    `"scripted-double"`), and `startup.metadata.bidirectionalInput = false`
 *    to make the absence of `--input-format stream-json` explicit. The
 *    M4.1 roadmap forbids claiming symmetric support: codex's documented
 *    `--json` output and `resume` continuation do not include the
 *    bidirectional input path that `--input-format stream-json` enables.
 *
 * The orchestrator (`runtime/orchestration/execute-once.ts`) treats both
 * doubles as plain `ProviderAdapter`s; the only behavioural difference is
 * the capability snapshot and the startup metadata the runtime can audit.
 * Tests may therefore exercise the same lifecycle events, byte-budgeted
 * stdin, and `disconnectOnFirstWrite` path against this class.
 */
import { EventEmitter } from "node:events";
import type { AdapterCapabilities, ProviderAdapter, ProviderHandle, SpawnRequest } from "./adapter";
import { SCRIPTED_INPUT_CAP_BYTES } from "./scripted-double";

/** Default capability snapshot for the codex scripted double. */
export const DEFAULT_CODEX_CAPABILITIES: AdapterCapabilities = {
  provider: "codex",
  version: "0.0.0-codex-scripted",
  featureCount: 4,
  probedAt: new Date(0).toISOString(),
};

export interface CodexScriptedProviderOptions {
  /** Capability snapshot override (used by tests that probe missing-binary paths). */
  readonly capabilities?: AdapterCapabilities;
  /** Same hook as the Claude scripted double: custom response injection. */
  readonly scriptedResponse?: (request: SpawnRequest, bytes: Uint8Array) => Array<{ bytes: number }>;
  /** Surface the disconnect-before-first-ack path. */
  readonly disconnectOnFirstWrite?: boolean;
}

/**
 * `CodexScriptedProviderDouble` is the M4.1 sibling of
 * `ScriptedProviderDouble`. It deliberately does **not** extend the
 * Claude double so the two can diverge (different capability snapshot,
 * different `startup.metadata`, different `kind` discriminator).
 *
 * The class is intentionally narrow: it shares the wire shape (line-
 * delimited lifecycle events on `lifecycle`, byte-budgeted stdin,
 * `acknowledge` frees backpressure, `exit` forces shutdown) but the
 * specific capability and metadata defaults differ.
 */
export class CodexScriptedProviderDouble implements ProviderAdapter {
  readonly kind = "scripted" as const;
  private readonly capabilitiesSnapshot: AdapterCapabilities;
  private readonly scriptedResponse: ((request: SpawnRequest, bytes: Uint8Array) => Array<{ bytes: number }>) | undefined;
  private readonly disconnectOnFirstWrite: boolean;

  constructor(options: CodexScriptedProviderOptions = {}) {
    this.capabilitiesSnapshot = options.capabilities ?? DEFAULT_CODEX_CAPABILITIES;
    this.scriptedResponse = options.scriptedResponse;
    this.disconnectOnFirstWrite = Boolean(options.disconnectOnFirstWrite);
  }

  async capabilities(): Promise<AdapterCapabilities> {
    // Refresh the probe timestamp per call so the orchestrator can
    // audit when the snapshot was taken. Same pattern as the Claude
    // double in `scripted-double.ts:65-68`.
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

    // Defer emit-on-disconnect through `setImmediate` (not microtask) for
    // the same reason as `scripted-double.ts:103-114` — the listener
    // subscription lands synchronously after the awaiting `spawn()` call
    // returns, so microtasks fire before subscription.
    if (this.disconnectOnFirstWrite) {
      setImmediate(() => {
        if (!exited) exit(null, "SIGPIPE");
      });
    }

    return {
      correlationId: req.correlationId,
      lifecycle,
      startup: {
        kind: "codex-scripted-double",
        correlationId: req.correlationId,
        metadata: {
          scheme: "codex",
          // Explicit non-claim of bidirectional input. M4.1 forbids
          // claiming symmetric support that the documented provider
          // does not advertise.
          bidirectionalInput: false,
        },
      },
      stdin: {
        write: async (bytes: Uint8Array) => {
          ensureOpen();
          queued += bytes.byteLength;
          if (queued > SCRIPTED_INPUT_CAP_BYTES)
            throw new Error(`Provider input busy: ${queued} bytes queued (cap ${SCRIPTED_INPUT_CAP_BYTES})`);
          // Default mirrors Claude: echo bytes back. Tests can override
          // via `scriptedResponse` to exercise error paths.
          const fragments = this.scriptedResponse
            ? this.scriptedResponse(req, bytes)
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
          if (!exited) exit(0, null);
        },
      },
      acknowledge: (bytes: number) => {
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
