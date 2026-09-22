/**
 * M3b.1 — provider registry tests.
 *
 * Coverage:
 *  - Default kind is "scripted" (MINIMAL_PROVIDER_KIND unset).
 *  - `MINIMAL_PROVIDER_KIND=native` resolves to the native factory.
 *  - Resolving an unregistered kind throws AppError("UNAVAILABLE", …).
 *  - `clearAdapterFactory` removes the registration.
 *  - `registeredKinds` reports the live set.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAdapterFactory,
  registeredKinds,
  resolveAdapter,
  resolveAdapterByKind,
  setAdapterFactory,
} from "../../../src/runtime/providers/registry";
import { ScriptedProviderDouble } from "../../../src/runtime/providers/scripted-double";
import { AppError } from "../../../src/shared/errors";
import type { ProviderAdapter } from "../../../src/runtime/providers/adapter";

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.MINIMAL_PROVIDER_KIND;
  if (value === undefined) delete process.env.MINIMAL_PROVIDER_KIND;
  else process.env.MINIMAL_PROVIDER_KIND = value;
  try { fn(); } finally {
    if (previous === undefined) delete process.env.MINIMAL_PROVIDER_KIND;
    else process.env.MINIMAL_PROVIDER_KIND = previous;
  }
}

test("default kind is scripted when MINIMAL_PROVIDER_KIND is unset", t => {
  setAdapterFactory("scripted", () => new ScriptedProviderDouble());
  t.after(() => clearAdapterFactory("scripted"));
  withEnv(undefined, () => {
    const adapter = resolveAdapter();
    assert.equal(adapter.kind, "scripted");
  });
});

test("MINIMAL_PROVIDER_KIND=native resolves to the native factory", t => {
  const native: ProviderAdapter = {
    kind: "native",
    capabilities: async () => ({ provider: "claude", version: null, featureCount: 0, probedAt: new Date().toISOString() }),
    spawn: async () => { throw new Error("not used"); },
  };
  setAdapterFactory("scripted", () => new ScriptedProviderDouble());
  setAdapterFactory("native", () => native);
  t.after(() => {
    clearAdapterFactory("scripted");
    clearAdapterFactory("native");
  });
  withEnv("native", () => {
    assert.equal(resolveAdapter(), native);
  });
});

test("resolveAdapter throws AppError UNAVAILABLE when no factory is registered", t => {
  // Ensure no factories for either kind.
  clearAdapterFactory("scripted");
  clearAdapterFactory("native");
  t.after(() => setAdapterFactory("scripted", () => new ScriptedProviderDouble()));
  withEnv("scripted", () => {
    assert.throws(
      () => resolveAdapter(),
      (err: unknown) => err instanceof AppError && err.failure.code === "UNAVAILABLE",
    );
  });
});

test("resolveAdapterByKind returns the registered factory regardless of env", t => {
  setAdapterFactory("scripted", () => new ScriptedProviderDouble());
  t.after(() => clearAdapterFactory("scripted"));
  const adapter = resolveAdapterByKind("scripted");
  assert.equal(adapter.kind, "scripted");
});

test("clearAdapterFactory removes the registration", () => {
  setAdapterFactory("scripted", () => new ScriptedProviderDouble());
  clearAdapterFactory("scripted");
  assert.equal(registeredKinds().includes("scripted"), false);
});

test("registeredKinds reports the live set", t => {
  clearAdapterFactory("scripted");
  clearAdapterFactory("native");
  setAdapterFactory("scripted", () => new ScriptedProviderDouble());
  setAdapterFactory("native", () => ({
    kind: "native",
    capabilities: async () => ({ provider: "claude", version: null, featureCount: 0, probedAt: new Date().toISOString() }),
    spawn: async () => { throw new Error("not used"); },
  }));
  t.after(() => {
    clearAdapterFactory("scripted");
    clearAdapterFactory("native");
  });
  const kinds = registeredKinds();
  assert.ok(kinds.includes("scripted"));
  assert.ok(kinds.includes("native"));
});
