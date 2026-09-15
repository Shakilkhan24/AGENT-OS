/**
 * M3b — provider adapter port.
 *
 * A `ProviderAdapter` is the seam between the runtime's orchestration code
 * and the concrete provider implementation. There are two concrete
 * implementations today:
 *   - `ScriptedProviderDouble` — in-process double used by tests + the
 *     early M3b demonstrations. Emits line-delimited JSON frames to an
 *     `EventTarget`, with the same byte-budgeted surface as the native runner.
 *   - `NativeFramedRunner` — real subprocess that emits
 *     `application/frame` envelopes on stdout. (Increment 3.)
 *
 * The orchestrator (`runtime/orchestration/execute-once.ts`) imports
 * neither concrete implementation; it asks the `ProviderRegistry` for an
 * adapter by `kind`. This means the orchestrator is identical regardless
 * of which adapter is active — switching from the scripted double to the
 * native runner requires no change to the orchestration code.
 */
import { EventEmitter } from "node:events";
import type { NativeSubagentSupport } from "../../shared/delegation-schema";

export type ProviderKind = "scripted" | "native";

/** What the adapter reports it can do, derived from the capability matrix. */
export interface AdapterCapabilities {
  /** Native provider this adapter binds to. */
  readonly provider: "claude" | "codex";
  /** Reported semantic version of the underlying binary (or `null` if unknown). */
  readonly version: string | null;
  /** Count of recognised features the binary supports (0 if unknown). */
  readonly featureCount: number;
  /** ISO timestamp the probe ran at. */
  readonly probedAt: string;
  /**
   * M5.3 — additive. Whether this adapter exposes a native
   * subagent path (a child the provider itself spawns in the
   * same workspace + host) and the runtime's best-case
   * observation level for those children. `undefined` means
   * "not advertised" — the M5.3 dispatcher treats absent as
   * "no native subagent support".
   */
  readonly nativeSubagentSupport?: NativeSubagentSupport;
}

/** Inputs the orchestrator hands to `spawn`. */
export interface SpawnRequest {
  /** Unique identifier for this dispatch — propagated as the frame `correlation_id`. */
  readonly correlationId: string;
  /** Adapter-supplied payload hash; used to detect duplicate-content disagreement. */
  readonly canonicalDigest: string;
  /** Provider identity triple. */
  readonly providerVersion: string;
  readonly model: string;
  readonly accountMode: "anonymous" | "authenticated" | "trusted-host";
  /** Caller-supplied deadline (ISO-8601). Adapter MUST refuse past-deadline writes. */
  readonly deadlineAt: string;
  /** Caller-supplied arguments (opaque JSON, adapter-shaped). */
  readonly argsJson: string;
  /** Caller-supplied scope metadata (opaque JSON). */
  readonly scopeJson: string;
  /** Optional parent invocation id (for linked retries). */
  readonly parentInvocationId: string | null;
}

/** Lifecycle event from a running handle. */
export type LifecycleEvent =
  | { readonly kind: "started"; readonly at: string }
  | { readonly kind: "output"; readonly bytes: number; readonly seq: number }
  | { readonly kind: "ack"; readonly seq: number }
  | { readonly kind: "exit"; readonly at: string; readonly code: number | null; readonly signal: NodeJS.Signals | null };

/** A live provider invocation. Returned from `spawn`. */
export interface ProviderHandle {
  /** The correlation id used to spawn the handle. */
  readonly correlationId: string;
  /** Lifecycle events the orchestrator observes. */
  readonly lifecycle: EventEmitter;
  /** Pushes bytes (encoded as the adapter expects) to the provider. Backpressured. */
  readonly stdin: { write: (bytes: Uint8Array) => Promise<void>; close: () => void };
  /** The adapter calls this when it has consumed `bytes` of output. */
  readonly acknowledge: (bytes: number) => void;
  /** Force-exit the handle (the runtime uses this for stop + escalation). */
  readonly exit: (reason: string) => Promise<void>;
  /** Adapter-supplied startup metadata (free-form, opaque JSON). May be `null`. */
  readonly startup: Record<string, unknown> | null;
  /**
   * M5.3 — additive. OS-level identity the runner captured at
   * spawn time. `pid` is always populated when the runner
   * successfully spawns a child; `pgid` is populated only when
   * the runner could capture a process-group id (typically
   * Linux + `setpgid`). The `observation` field is the level
   * the M5.3 dispatcher reads; existing callers can ignore
   * this whole field.
   */
  readonly nativeProcess?: {
    readonly pid: number;
    readonly pgid: number | null;
    readonly observation: "fully-observed" | "pid-only";
  };
}

export interface ProviderAdapter {
  readonly kind: ProviderKind;
  /** Resolved capabilities (mirrors the matrix's `native` field). */
  capabilities(): Promise<AdapterCapabilities>;
  /** Spawn a handle. The adapter MUST emit a `started` lifecycle event before returning. */
  spawn(req: SpawnRequest): Promise<ProviderHandle>;
}