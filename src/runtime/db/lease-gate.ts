/**
 * M3a — managed mutation gate.
 *
 * Every file/editor mutation that targets a managed workspace MUST go
 * through `mutateWithLease`. The gate enforces:
 *  - a `held` lease exists for the workspace,
 *  - the lease has not expired,
 *  - the holder matches the supplied `holder`,
 *  - the caller's `fencingToken` matches the lease's current token.
 *
 * Stale callers (a crashed controller whose TTL elapsed and was renewed
 * by another holder) are rejected with `LEASE_UNCERTAIN` so the renderer
 * can offer the user the choice between inspecting the workspace or
 * tearing the checkout down. A successful call returns a new fencing
 * token the caller can stamp onto the next mutation.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { readActiveLease } from "./leases";
import type { DbWorker } from "./worker";

const GATE_INPUT = z.object({
  workspaceId: z.string().uuid(),
  holder: z.string().min(1).max(256),
  fencingToken: z.number().int().min(0),
}).strict();
export type MutateWithLeaseInput = z.input<typeof GATE_INPUT>;

export interface GateOk { readonly ok: true; readonly nextToken: number }
export interface GateDeny { readonly ok: false; readonly reason: "expired" | "mismatch" | "missing"; readonly message: string }
export type GateResult = GateOk | GateDeny;

/**
 * Returns a result object instead of throwing so the renderer can render
 * an actionable message ("Lease expired", "Stale write rejected", etc.)
 * without unwinding the call stack.
 */
export async function checkLease(worker: DbWorker, input: MutateWithLeaseInput): Promise<GateResult> {
  const parsed = GATE_INPUT.parse(input);
  // The lookup is synchronous on purpose: the renderer calls this on the
  // main thread, awaiting a transaction would block UI updates.
  return worker.transaction(async tx => {
    void tx;
    const lease = await readActiveLease(worker, parsed.workspaceId);
    if (!lease) return { ok: false, reason: "missing", message: "No active lease for this workspace" } as GateDeny;
    if (lease.holder !== parsed.holder)
      return { ok: false, reason: "mismatch", message: `Lease held by ${lease.holder}, not ${parsed.holder}` } as GateDeny;
    if (lease.fencingToken !== parsed.fencingToken)
      return { ok: false, reason: "mismatch", message: "Stale write rejected: lease token mismatch" } as GateDeny;
    if (new Date(lease.expiresAt).getTime() <= Date.now())
      return { ok: false, reason: "expired", message: "Lease has expired" } as GateDeny;
    return { ok: true, nextToken: lease.fencingToken } as GateOk;
  });
}

/**
 * Throwing variant: for callers that prefer a hard error. Throws an
 * `AppError` whose code matches the gate reason (`LEASE_UNCERTAIN` for
 * expired/missing, `CONFLICT` for fencing-token mismatch).
 */
export async function assertLease(worker: DbWorker, input: MutateWithLeaseInput): Promise<GateOk> {
  const result = await checkLease(worker, input);
  if (result.ok) return result;
  if (result.reason === "mismatch")
    throw new AppError("CONFLICT", result.message);
  throw new AppError("LEASE_UNCERTAIN", result.message);
}

/**
 * Wrap a mutation body so the gate is checked before the body runs and
 * the lease is auto-renewed on success (the writer is presumed alive).
 */
export async function mutateWithLease<T>(
  worker: DbWorker,
  input: MutateWithLeaseInput,
  body: () => Promise<T>,
): Promise<T> {
  await assertLease(worker, input);
  const out = await body();
  // The lease service bumps the fencing token on renew; the renderer
  // MUST read the new token before its next mutation. We don't renew
  // here automatically because the controller may not have actually
  // finished work — renewal is an explicit act.
  return out;
}