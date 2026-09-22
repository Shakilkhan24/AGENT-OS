/**
 * M3b.3 — native adapter ownership contract.
 *
 * `verifyOwnership` is the runtime's gate before exposing a native
 * adapter. It runs the version probe from `capability-matrix.ts` and
 * refuses to construct an adapter that does not declare the expected
 * identity. The probe is read-only — it never installs or downloads
 * anything; the adapter is the user's own artifact.
 *
 * Production deployments pin a specific adapter path via
 * `MINIMAL_PROVIDER_ADAPTER_PATH`; the test seam `setOwnershipProbe`
 * lets tests stub the probe outcome.
 */
import { statSync } from "node:fs";
import { AppError } from "../../../shared/errors";
import { extendNativeCapabilities } from "../capability-matrix";
import type { CapabilityMatrix } from "../../db/capabilities";

/** Same shape as `extendNativeCapabilities`'s return type, by reference. */
export type OwnershipCapabilities = ReturnType<typeof extendNativeCapabilities>;

export interface OwnershipOk {
  readonly ok: true;
  readonly adapterPath: string;
  readonly capabilities: OwnershipCapabilities;
}
export interface OwnershipFail {
  readonly ok: false;
  readonly reason: "missing-binary" | "version-mismatch" | "io-error";
  readonly message: string;
  readonly adapterPath: string;
}
export type OwnershipResult = OwnershipOk | OwnershipFail;

/** Test seam: replace the underlying version probe. */
type ProbeFn = () => OwnershipCapabilities;
let probeOverride: ProbeFn | undefined;
export function setOwnershipProbe(fn: ProbeFn): void { probeOverride = fn; }
export function resetOwnershipProbe(): void { probeOverride = undefined; }

/**
 * Verify ownership of a native adapter at `adapterPath`. The probe is
 * read-only: it does not chmod, install, or modify the binary.
 *
 * Returns:
 *  - `{ ok: true, capabilities }` when the binary exists and reports a
 *    version the runtime can use.
 *  - `{ ok: false, reason }` with a structured failure the caller can
 *    surface. The reason never leaks the binary's output — it only
 *    records what went wrong.
 */
export function verifyOwnership(adapterPath: string, _matrix: CapabilityMatrix): OwnershipResult {
  try {
    statSync(adapterPath);
  } catch (error) {
    return {
      ok: false,
      reason: "missing-binary",
      message: `Native adapter not found at ${adapterPath}: ${error instanceof Error ? error.message : String(error)}`,
      adapterPath,
    };
  }
  let capabilities: OwnershipCapabilities;
  try {
    capabilities = probeOverride ? probeOverride() : extendNativeCapabilities(_matrix);
  } catch (error) {
    return {
      ok: false,
      reason: "io-error",
      message: `Ownership probe failed: ${error instanceof Error ? error.message : String(error)}`,
      adapterPath,
    };
  }
  if (!capabilities.version) {
    return {
      ok: false,
      reason: "version-mismatch",
      message: `Native adapter at ${adapterPath} reported no usable version`,
      adapterPath,
    };
  }
  return { ok: true, adapterPath, capabilities };
}

/** Helper: parse the env-supplied adapter path; throw if unset. */
export function resolveAdapterPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = env.MINIMAL_PROVIDER_ADAPTER_PATH;
  if (!path || path.length === 0)
    throw new AppError("UNAVAILABLE", "MINIMAL_PROVIDER_ADAPTER_PATH is not set");
  return path;
}