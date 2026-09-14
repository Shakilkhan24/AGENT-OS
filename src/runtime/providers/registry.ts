/**
 * M3b — provider registry.
 *
 * Resolves a `ProviderKind` ("scripted" or "native") to a concrete
 * `ProviderAdapter`. Production code looks up the adapter by reading
 * `MINIMAL_PROVIDER_KIND` (default "scripted" — the native path lands in
 * Increment 3). Tests use `setAdapterFactory` to install a specific
 * implementation.
 *
 * The registry is intentionally process-global: the runtime has one
 * active provider per process, and the orchestrator picks it up from a
 * single call site. The test seam follows the same pattern as
 * `setCapabilityProbe` / `resetCapabilityProbe` in `capabilities.ts:89-92`.
 */
import { AppError } from "../../shared/errors";
import type { ProviderAdapter, ProviderKind } from "./adapter";

type AdapterFactory = () => ProviderAdapter;

const factories = new Map<ProviderKind, AdapterFactory>();

/** Register an adapter factory for the given kind. */
export function setAdapterFactory(kind: ProviderKind, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

/** Remove an adapter factory. Primarily for test teardown. */
export function clearAdapterFactory(kind: ProviderKind): void {
  factories.delete(kind);
}

/** Look up the configured adapter. */
export function resolveAdapter(): ProviderAdapter {
  const kind = parseProviderKind(process.env.MINIMAL_PROVIDER_KIND);
  const factory = factories.get(kind);
  if (!factory)
    throw new AppError("UNAVAILABLE", `No provider adapter registered for kind "${kind}"`);
  return factory();
}

/** Look up a specific adapter kind (used by tests to probe parity). */
export function resolveAdapterByKind(kind: ProviderKind): ProviderAdapter {
  const factory = factories.get(kind);
  if (!factory)
    throw new AppError("UNAVAILABLE", `No provider adapter registered for kind "${kind}"`);
  return factory();
}

function parseProviderKind(raw: string | undefined): ProviderKind {
  if (raw === "native" || raw === "scripted") return raw;
  return "scripted";
}

/** Test seam: list registered kinds (for assertions). */
export function registeredKinds(): ProviderKind[] {
  return [...factories.keys()];
}