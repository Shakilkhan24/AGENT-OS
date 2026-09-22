/**
 * M4.1 — Codex native adapter factory tests.
 *
 * Coverage:
 *  - `capabilities()` raises `AppError("UNAVAILABLE", …)` when the
 *    adapter path does not exist (missing-binary path).
 *  - `capabilities()` raises the same refusal when the capability
 *    matrix reports `codex.version === null` (version-mismatch path).
 *  - A pre-supplied `capabilities` option short-circuits the probe and
 *    returns the override directly (so tests can drive the success
 *    path without a real binary on PATH).
 *  - `spawn()` runs the same probe and refuses the same way.
 *
 * The codex adapter mirrors `runtime/providers/native/index.ts`'s
 * `createNativeAdapter` factory but is a sibling rather than a shared
 * base class — M4.1 forbids claiming symmetric support.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexNativeAdapter } from "../../../src/runtime/providers/codex-adapter";
import { AppError } from "../../../src/shared/errors";
import { setCapabilityProbe, resetCapabilityProbe } from "../../../src/runtime/db/capabilities";

const baseRequest = {
  correlationId: "corr-codex-native-1",
  canonicalDigest: "c".repeat(64),
  providerVersion: "codex-0.0.1",
  model: "codex-default",
  accountMode: "authenticated" as const,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  argsJson: "{}",
  scopeJson: "{}",
  parentInvocationId: null,
};

test("capabilities refuses when the adapter path does not exist", async () => {
  // A path that cannot possibly exist on any sane filesystem.
  const bogus = path.join(tmpdir(), "minimal-codex-missing", `${Date.now()}-nope`);
  const adapter = createCodexNativeAdapter({ adapterPath: bogus });
  await assert.rejects(
    adapter.capabilities(),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).failure.code, "UNAVAILABLE");
      return true;
    },
  );
});

test("capabilities refuses when the capability matrix reports no codex version", async (t) => {
  // Stub the matrix so `codex.version === null` (the version-mismatch
  // branch). Restore the original probe at the end of the test.
  setCapabilityProbe(() => ({
    installed: { git: true, tmux: true, python3: true, node: true },
    native: { claude: false, codex: false, version: null, featureCount: 0 },
    supportedRestrictions: ["read-only-filesystem"],
    unsupportedRestrictions: ["no-network", "no-shell-exec"],
    probedAt: new Date().toISOString(),
    hostTag: "trusted",
  }));
  t.after(() => resetCapabilityProbe());

  // The path *does* exist (tmpdir is real), so the only refusal cause is
  // the version-mismatch branch.
  const adapter = createCodexNativeAdapter({ adapterPath: tmpdir() });
  await assert.rejects(
    adapter.capabilities(),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).failure.code, "UNAVAILABLE");
      return true;
    },
  );
});

test("capabilities returns the override when supplied", async () => {
  const override = {
    provider: "codex" as const,
    version: "codex-0.1.0",
    featureCount: 4,
    probedAt: new Date().toISOString(),
  };
  const adapter = createCodexNativeAdapter({
    adapterPath: "/nonexistent", // would otherwise fail
    capabilities: override,
  });
  const caps = await adapter.capabilities();
  assert.deepEqual(caps, override);
});

test("spawn refuses with UNAVAILABLE when the adapter path is missing", async () => {
  const bogus = path.join(tmpdir(), "minimal-codex-missing", `${Date.now()}-also-nope`);
  const adapter = createCodexNativeAdapter({ adapterPath: bogus });
  await assert.rejects(
    adapter.spawn(baseRequest),
    (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal((err as AppError).failure.code, "UNAVAILABLE");
      return true;
    },
  );
});

test("kind discriminator is 'native' to match the registry contract", () => {
  const adapter = createCodexNativeAdapter({ adapterPath: "/nonexistent" });
  assert.equal(adapter.kind, "native");
});

test("M4.5: providerProfile is accepted by the factory and used in the spawn path", async (t) => {
  // The M4.5 contract: `createCodexNativeAdapter` accepts an
  // optional `providerProfile` and threads it through to
  // `spawnFramedRunner`. We assert the option round-trips by
  // driving `capabilities()` with a probe override (no spawn)
  // — the adapter's capability probe is independent of the
  // profile, so this verifies the factory accepts the new
  // option without changing capability semantics. The actual
  // translation behaviour is covered by
  // `tests/runtime/providers/config-translator.test.ts` and the
  // runner error path is covered by
  // `tests/runtime/providers/native/codex-framed-runner.test.ts`.
  setCapabilityProbe(() => ({
    installed: { git: true, tmux: true, python3: true, node: true },
    native: { claude: false, codex: true, version: "codex-0.1.0", featureCount: 4 },
    supportedRestrictions: ["read-only-filesystem"],
    unsupportedRestrictions: ["no-network", "no-shell-exec"],
    probedAt: new Date().toISOString(),
    hostTag: "trusted",
  }));
  t.after(() => resetCapabilityProbe());
  const adapter = createCodexNativeAdapter({
    adapterPath: tmpdir(),
    providerProfile: {
      binaryArgs: ["--strict-json"],
      envOverrides: {},
      workingDirectory: null,
    },
  });
  // Capabilities are unaffected by `providerProfile`.
  const caps = await adapter.capabilities();
  assert.equal(caps.provider, "codex");
  assert.equal(caps.featureCount, 4);
  // The factory still reports itself as a native-kind adapter.
  assert.equal(adapter.kind, "native");
});
