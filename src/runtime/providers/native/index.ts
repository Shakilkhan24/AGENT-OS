/**
 * M3b.3 — native adapter factory.
 *
 * `createNativeAdapter` runs the ownership contract (Increment 1's
 * `extendNativeCapabilities` + a path existence check) before
 * constructing the framed runner. A failed ownership check raises
 * `AppError("UNAVAILABLE", …)` so the orchestrator can surface the
 * refusal without trying to spawn a non-existent adapter.
 */
import { AppError } from "../../../shared/errors";
import type { ProviderAdapter, AdapterCapabilities } from "../adapter";
import { verifyOwnership } from "./ownership-contract";
import { spawnFramedRunner } from "./framed-runner";
import { probeCapabilities } from "../../db/capabilities";
import type { SpawnRequest, ProviderHandle } from "../adapter";

export interface NativeAdapterOptions {
  /** Path to the native adapter binary. */
  readonly adapterPath: string;
  /** Capability override for tests. */
  readonly capabilities?: AdapterCapabilities;
}

export function createNativeAdapter(options: NativeAdapterOptions): ProviderAdapter {
  const adapterPath = options.adapterPath;
  return {
    kind: "native",
    async capabilities(): Promise<AdapterCapabilities> {
      if (options.capabilities) return options.capabilities;
      const caps = await probeCapabilities();
      const result = verifyOwnership(adapterPath, caps);
      if (!result.ok) throw new AppError("UNAVAILABLE", result.message);
      return {
        provider: result.capabilities.claude ? "claude" : "codex",
        version: result.capabilities.version,
        featureCount: result.capabilities.featureCount,
        probedAt: new Date().toISOString(),
      };
    },
    async spawn(req: SpawnRequest): Promise<ProviderHandle> {
      const caps = await probeCapabilities();
      const result = verifyOwnership(adapterPath, caps);
      if (!result.ok) throw new AppError("UNAVAILABLE", result.message);
      return spawnFramedRunner(adapterPath, req);
    },
  };
}