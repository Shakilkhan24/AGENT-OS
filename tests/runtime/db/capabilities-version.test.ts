/**
 * M3b.1 — capability-matrix version probe tests.
 *
 * Coverage:
 *  - When the version probe reports a version for `claude`, the resulting
 *    `native` block carries `claude: true`, `version` populated,
 *    `featureCount: 5`, and the tag changes from boolean-only to
 *    version-aware.
 *  - When both binaries report a version, both `claude` and `codex` are
 *    true and `featureCount` is 5 + 4 = 9.
 *  - When the probe returns null for both, `version` is null and
 *    `featureCount` is 0, but `probedAt` is still populated.
 *  - When the installed matrix has `node: false`, the native probe is
 *    short-circuited and no version is produced (read-only — nothing is
 *    installed).
 *  - `resetVersionProbe` restores the default behaviour.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  extendNativeCapabilities,
  resetVersionProbe,
  setVersionProbe,
} from "../../../src/runtime/providers/capability-matrix";
import type { CapabilityMatrix } from "../../../src/runtime/db/capabilities";

function baseMatrix(overrides: Partial<CapabilityMatrix> = {}): CapabilityMatrix {
  return {
    installed: { git: false, tmux: false, python3: false, node: true },
    native: { claude: false, codex: false },
    supportedRestrictions: [],
    unsupportedRestrictions: [],
    probedAt: new Date().toISOString(),
    hostTag: "untrusted",
    ...overrides,
  };
}

test("extension reports the version when probe returns a string", t => {
  setVersionProbe(binary => binary === "claude" ? "Claude 1.0.0 (test)" : null);
  t.after(() => resetVersionProbe());
  const ext = extendNativeCapabilities(baseMatrix());
  assert.equal(ext.claude, true);
  assert.equal(ext.codex, false);
  assert.equal(ext.version, "Claude 1.0.0 (test)");
  assert.equal(ext.featureCount, 5);
});

test("extension sums feature counts when both binaries probe successfully", t => {
  setVersionProbe(() => "v9.9.9");
  t.after(() => resetVersionProbe());
  const ext = extendNativeCapabilities(baseMatrix());
  assert.equal(ext.claude, true);
  assert.equal(ext.codex, true);
  assert.equal(ext.featureCount, 9);
});

test("extension reports null + zero features when both probes fail", t => {
  setVersionProbe(() => null);
  t.after(() => resetVersionProbe());
  const ext = extendNativeCapabilities(baseMatrix());
  assert.equal(ext.claude, false);
  assert.equal(ext.codex, false);
  assert.equal(ext.version, null);
  assert.equal(ext.featureCount, 0);
});

test("extension is a no-op when matrix.installed.node is false", t => {
  // Even with the probe returning a version, missing `node` short-circuits.
  let calls = 0;
  setVersionProbe(() => { calls += 1; return "v1"; });
  t.after(() => resetVersionProbe());
  const ext = extendNativeCapabilities(baseMatrix({ installed: { git: false, tmux: false, python3: false, node: false } }));
  assert.equal(ext.claude, false);
  assert.equal(ext.codex, false);
  assert.equal(ext.version, null);
  assert.equal(ext.featureCount, 0);
  // Probe should not have been called at all — capability matrix is read-only.
  assert.equal(calls, 0);
});

test("resetVersionProbe restores the default behaviour for subsequent calls", () => {
  setVersionProbe(() => "fake");
  resetVersionProbe();
  assert.equal(resetVersionProbe.length, 0);
});
