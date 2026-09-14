/**
 * M3b.2 — execute-once orchestrator.
 *
 * `executeOnce` is the runtime's primary entry point for a single
 * provider-bound round-trip. It is the seam that enforces M3b's start
 * ordering from `FUTURE/IMPLEMENTATION-README.md:192`:
 *
 *   1. authenticate / scope  → already enforced by the caller's grant /
 *      authority chain (out of scope for this module — see `runtime/main/`).
 *   2. resolve idempotency key + canonical digest  → `createInvocation` in
 *      `db/invocations.ts`. Same `(runId, idempotencyKey)` re-hit returns
 *      the original invocation; a different digest raises CONFLICT.
 *   3. for new requests only: check revision / capacity / authority
 *      → handled by `runtime/db/` services upstream of this entry point.
 *      The orchestrator itself trusts the inputs it has been handed.
 *   4. transactionally record intent  → `recordDispatchIntent`.
 *   5. backend durable exclusive claim  → the `claimed` state of the
 *      intent + a `held` lease over the workspace.
 *   6. spawn  → the `ProviderAdapter.spawn` call + invocation transition
 *      to `spawned` (handled here).
 *   7. persist observation  → `recordObservation` (Increment 3 wraps this
 *      in the same transaction as the invocation terminal transition).
 *
 * If the handle disconnects before the first ack, the orchestrator calls
 * `markAmbiguous` (in `uncertain.ts`). An ambiguous dispatch is terminal —
 * it is never respawned by a second `executeOnce`.
 *
 * Decision rule: this module NEVER mutates entities outside the supplied
 * worker; it coordinates them. The bounds on capacity / authority /
 * revision are upstream, but the orchestrator surfaces a CONFLICT for any
 * state-machine violation it observes (a stale revision, a stale
 * dispatch-intent transition, etc.).
 */
import { z } from "zod";
import { EventEmitter } from "node:events";
import type { DbWorker } from "../db/worker";
import { AppError } from "../../shared/errors";
import {
  createInvocation,
  readInvocation,
  transitionInvocation,
} from "../db/invocations";
import {
  recordDispatchIntent,
  transitionDispatchIntent,
} from "../db/dispatch-intents";
import { resolveAdapter } from "../providers/registry";
import {
  type ProviderHandle,
  type SpawnRequest,
} from "../providers/adapter";
import { markAmbiguous } from "./uncertain";
import { isStopped } from "./stop-policy";

const EXECUTE_ONCE_INPUT = z.object({
  runId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(256),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  method: z.string().min(1).max(128),
  args: z.unknown().default({}),
  scope: z.unknown().default({}),
  deadlineAt: z.string().datetime(),
  parentInvocationId: z.string().uuid().nullable().default(null),
  revision: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
});
export type ExecuteOnceInput = z.input<typeof EXECUTE_ONCE_INPUT>;

export interface ExecuteOnceOk {
  readonly kind: "ok";
  readonly invocationId: string;
  readonly handle: ProviderHandle;
  readonly rehydrated: boolean;
  readonly dispatchIntentId: string;
}
export interface ExecuteOnceAmbiguous {
  readonly kind: "ambiguous";
  readonly invocationId: string;
  readonly reason: string;
}
export interface ExecuteOnceConflict {
  readonly kind: "conflict";
  readonly reason: string;
  readonly invocationId?: string;
}
export type ExecuteOnceResult = ExecuteOnceOk | ExecuteOnceAmbiguous | ExecuteOnceConflict;

/** Test seam: swap the adapter without going through the registry. */
let adapterOverride: { spawn: typeof resolveAdapter } | undefined;

/** Test-only: install an explicit adapter resolver. */
export function setExecuteOnceAdapter(resolver: typeof resolveAdapter): void {
  adapterOverride = { spawn: resolver };
}
/** Test-only: clear the explicit resolver. */
export function resetExecuteOnceAdapter(): void {
  adapterOverride = undefined;
}

/**
 * Run one provider dispatch under M3b's strict ordering. The orchestrator
 * either returns an `ok` handle (which the caller writes to through
 * `handle.stdin.write(...)` then closes), an `ambiguous` error if the
 * handle died before the first ack, or a `conflict` for idempotency /
 * state-machine violations.
 *
 * The returned `handle` is the real `ProviderHandle`; the orchestrator
 * wires an internal EventEmitter so the caller can subscribe to lifecycle
 * events without pulling one off the adapter (which would race against
 * the subscription).
 */
export async function executeOnce(
  worker: DbWorker,
  input: ExecuteOnceInput,
): Promise<ExecuteOnceResult> {
  const parsed = EXECUTE_ONCE_INPUT.parse(input);
  // Per-run stop gate. If the run has been cancelled, future
  // `executeOnce` calls refuse to spawn a new adapter; the caller
  // surfaces the unconfirmed descendants in the run summary.
  if (isStopped(parsed.runId))
    return {
      kind: "conflict",
      reason: `Run ${parsed.runId} is stopped; executeOnce is blocked`,
    };
  // Resolve the adapter eagerly so all return paths share the same instance
  // (the registry may be a process-wide singleton in production; the test
  // seam swaps the resolver explicitly).
  const adapter = adapterOverride ? adapterOverride.spawn() : resolveAdapter();
  // ── 2 + 3. idempotency + revision ─────────────────────────────────────
  const invocation = await createInvocation(worker, {
    runId: parsed.runId,
    idempotencyKey: parsed.idempotencyKey,
    canonicalDigest: parsed.canonicalDigest,
    providerVersion: parsed.providerVersion,
    model: parsed.model,
    accountMode: parsed.accountMode,
  });
  // Replay path: same (runId, idem) already exists; check the digest.
  if (invocation.status === "error" || invocation.status === "done") {
    // Terminal invocation — respawn is forbidden. The caller sees an
    // ambiguous error mapped from the recorded `ended_reason`.
    return {
      kind: "ambiguous",
      invocationId: invocation.id,
      reason: invocation.endedReason ?? `invocation is in terminal state ${invocation.status}`,
    };
  }
  // If the invocation is mid-flight (admitted / spawned / observing), a
  // re-hit returns the original invocation's id with a rehydrated=true
  // flag. The caller is responsible for re-subscribing to the original
  // handle's lifecycle; this module does not retain it (the scripted
  // double's handle is process-local). D-4 documents the rule; see also
  // `runtime/control-client.ts:10` for the no-reconnect invariant.
  if (invocation.status !== "pending") {
    return {
      kind: "ok",
      invocationId: invocation.id,
      handle: syntheticReplayHandle(invocation.id),
      rehydrated: true,
      dispatchIntentId: "",
    };
  }
  // ── 4 + 5. intent claim ───────────────────────────────────────────────
  // Record a fresh intent every time (the orchestrator's audit trail is
  // per-call). The first transition moves it to `claimed` (durable
  // exclusive claim); the next to `spawned` once the adapter has the
  // process. Idempotent retries with the same idempotencyKey share the
  // invocation but still mint a new intent so the audit carries every
  // attempt. (D-4 forbids respawning an ambiguous dispatch — see
  // `markAmbiguous`.)
  const intent = await recordDispatchIntent(worker, {
    runId: parsed.runId,
    invocationId: invocation.id,
    method: parsed.method,
    args: parsed.args,
    scope: parsed.scope,
    deadlineAt: parsed.deadlineAt,
  });
  await transitionDispatchIntent(worker, intent.id, "claimed");
  // ── 6. spawn ──────────────────────────────────────────────────────────
  const spawnReq: SpawnRequest = {
    correlationId: invocation.id,
    canonicalDigest: parsed.canonicalDigest,
    providerVersion: parsed.providerVersion,
    model: parsed.model,
    accountMode: parsed.accountMode,
    deadlineAt: parsed.deadlineAt,
    argsJson: JSON.stringify(parsed.args ?? {}),
    scopeJson: JSON.stringify(parsed.scope ?? {}),
    parentInvocationId: parsed.parentInvocationId,
  };
  const handle = await adapter.spawn(spawnReq);
  await transitionDispatchIntent(worker, intent.id, "spawned");
  // pending → admitted → spawned. The intent's `spawned` transition
  // corresponds to "the adapter has accepted the request"; the matching
  // invocation transition lands the call in the same observable state.
  if (invocation.status === "pending")
    await transitionInvocation(worker, invocation.id, { to: "admitted" });
  await transitionInvocation(worker, invocation.id, { to: "spawned" });

  // Wire the lifecycle observer BEFORE returning. EventEmitter calls
  // listeners synchronously, so the disconnect path runs in-band and
  // `markAmbiguous` is executed before the caller can race.
  let sawAck = false;
  handle.lifecycle.on("event", (event) => {
    if (event.kind === "ack") sawAck = true;
    if (event.kind === "exit" && event.code === null && event.signal && !sawAck) {
      // Disconnect before first ack → ambiguous. The adapter that uses the
      // orchestrator must call `handle.acknowledge(...)` only after the
      // observation has been durably written.
      markAmbiguous(worker, {
        invocationId: invocation.id,
        correlationId: invocation.id,
        reason: `provider disconnected before first ack (signal ${event.signal})`,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        handle.lifecycle.emit("error", new AppError("INTERNAL", `markAmbiguous failed: ${message}`));
      });
    }
  });

  return {
    kind: "ok",
    invocationId: invocation.id,
    handle,
    rehydrated: invocation.startedAt !== null,
    dispatchIntentId: intent.id,
  };
}

/** Test seam: look up the invocation by id (for assertions). */
export async function readExecuteOnceInvocation(worker: DbWorker, id: string) {
  return readInvocation(worker, id);
}

/**
 * Build a no-op handle for the replay path. The original handle's
 * transport is gone (the spawned adapter has long since exited), so the
 * orchestrator returns a fresh handle whose lifecycle is empty. A real
 * production rehydration would consult the spool (Increment 3) and emit a
 * `provider.observation` event for the original exit before returning.
 */
function syntheticReplayHandle(correlationId: string): ProviderHandle {
  const lifecycle = new EventEmitter();
  return {
    correlationId,
    lifecycle,
    startup: { kind: "rehydrated", correlationId },
    stdin: {
      write: async () => { throw new AppError("UNAVAILABLE", "Cannot write to a rehydrated handle"); },
      close: () => { /* nothing to close */ },
    },
    acknowledge: () => { /* no outstanding acks on a rehydrated handle */ },
    exit: async () => { /* already exited */ },
  };
}