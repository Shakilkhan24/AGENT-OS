/**
 * M4.1 — Codex native adapter factory.
 *
 * Parallel to `runtime/providers/native/index.ts`'s
 * `createNativeAdapter` (the M3b.3 Claude adapter), but bound to the
 * codex binary. M4.1's roadmap says "do not claim symmetric support":
 * the two adapters are deliberately separated rather than unified, so a
 * future provider-feature matrix can record exactly which features each
 * adapter advertises.
 *
 * The codex adapter:
 *  - reports `provider: "codex"` with `featureCount: 4` (matching the
 *    codex slot in `capability-matrix.ts:64`),
 *  - exposes the same `ProviderHandle` lifecycle as the Claude runner
 *    (spawn → started → output → ack → exit), re-using
 *    `runtime/providers/native/framed-runner.ts`,
 *  - rejects the bid path explicitly via
 *    `startup.metadata.bidirectionalInput = false` (set inside the
 *    runner's startup envelope — see `framed-runner.ts:75-77`).
 *
 * The codex version probe is dedicated (`probeCodexBinary`) and refuses
 * a codex adapter when the binary is missing or reports no version. The
 * Claude and Codex adapters therefore cannot accidentally cross-bind.
 */
import { statSync } from "node:fs";
import { AppError } from "../../shared/errors";
import type { ProviderAdapter, AdapterCapabilities, SpawnRequest, ProviderHandle } from "./adapter";
import { spawnFramedRunner } from "./native/framed-runner";
import type { ProviderConfig } from "./config-translator";
import { probeCapabilities } from "../db/capabilities";

export interface CodexNativeAdapterOptions {
  /** Path to the codex adapter binary. */
  readonly adapterPath: string;
  /** Capability snapshot override for tests. */
  readonly capabilities?: AdapterCapabilities;
  /**
   * M4.5: provider-native configuration translation. When
   * supplied, the framed runner translates the config into
   * explicit argv and merges `envOverrides` on top of `process.env`
   * for the child. When omitted (the M4.1 default), the runner
   * spawns the codex adapter with the original behaviour.
   */
  readonly providerProfile?: ProviderConfig;
}

/**
 * Probe the codex binary at `adapterPath`. Returns a capability
 * snapshot the adapter factory can hand to the orchestrator, or
 * `null` if the binary is missing / version-less.
 *
 * Read-only: never chmods, installs, or rewrites the binary.
 */
function probeCodexBinary(adapterPath: string, baseVersion: string | null): AdapterCapabilities | null {
  try {
    // The probe is structural: it asserts the path exists and reuses
    // the existing capability-matrix to record `featureCount: 4` for
    // the codex slot. A more rigorous version parser belongs to a
    // future increment that performs account-authorized trials; M4.1
    // records the discovery evidence without claiming qualification.
    statSync(adapterPath);
  } catch (error) {
    void error;
    return null;
  }
  if (baseVersion === null) return null;
  return {
    provider: "codex",
    version: baseVersion,
    featureCount: 4,
    probedAt: new Date().toISOString(),
  };
}

/**
 * Construct a `ProviderAdapter` for the codex binary. Mirrors
 * `createNativeAdapter` (`runtime/providers/native/index.ts:23-49`).
 *
 * Behaviour:
 *  - `capabilities()` returns the probe result, raising
 *    `AppError("UNAVAILABLE", …)` if the probe fails.
 *  - `spawn()` runs the probe again, raising the same `UNAVAILABLE`
 *    refusal on failure, then delegates to `spawnFramedRunner`.
 *
 * The factory does not own state; it is safe to call repeatedly inside
 * a single runtime process.
 */
export function createCodexNativeAdapter(options: CodexNativeAdapterOptions): ProviderAdapter {
  const adapterPath = options.adapterPath;
  return {
    kind: "native",
    async capabilities(): Promise<AdapterCapabilities> {
      if (options.capabilities) return options.capabilities;
      const matrix = await probeCapabilities();
      const codexVersion = matrix.native && "version" in matrix.native
        ? (matrix.native.codex ? matrix.native.version : null)
        : null;
      const caps = probeCodexBinary(adapterPath, codexVersion);
      if (!caps) {
        throw new AppError(
          "UNAVAILABLE",
          `Codex adapter at ${adapterPath} is unavailable (binary missing or version unknown)`,
        );
      }
      return caps;
    },
    async spawn(req: SpawnRequest): Promise<ProviderHandle> {
      const matrix = await probeCapabilities();
      const codexVersion = matrix.native && "version" in matrix.native
        ? (matrix.native.codex ? matrix.native.version : null)
        : null;
      const caps = probeCodexBinary(adapterPath, codexVersion);
      if (!caps) {
        throw new AppError(
          "UNAVAILABLE",
          `Codex adapter at ${adapterPath} cannot be spawned (binary missing or version unknown)`,
        );
      }
      return spawnFramedRunner(adapterPath, req, {
        providerProfile: options.providerProfile,
      });
    },
  };
}
