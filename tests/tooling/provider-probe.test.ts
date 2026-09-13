import test from "node:test";
import assert from "node:assert/strict";
import { inspectHelp } from "../../scripts/provider-probe.mts";

test("provider discovery distinguishes advertised flags from verified lifecycle support", () => {
  const codex = inspectHelp("codex", "codex-cli 0.154.0\n", "  resume  Continue\n  --json  JSONL\n  --ignore-user-config  Skip config");
  assert.equal(codex.version, "0.154.0");
  assert.equal(codex.advertised.structuredOutput, true);
  assert.equal(codex.advertised.continuation, true);
  assert.equal(codex.advertised.bidirectionalInput, false);
  assert.equal(codex.productionQualified, false);
  const claude = inspectHelp("claude", "2.1.268 (Claude Code)", "  --output-format stream-json\n  --input-format stream-json\n  --bg, --background  Run in background\n  --resume [value]");
  assert.equal(claude.advertised.backgroundLifecycle, true);
  assert.equal(claude.advertised.bidirectionalInput, true);
  assert.equal(claude.crashRecoveryVerified, false);
});

test("unknown versions and similarly named flags cannot establish compatibility", () => {
  const probe = inspectHelp("codex", "next-development-build", "  --json-schema file\n  --ignore-user-config-extra\n resumeLater");
  assert.equal(probe.version, null);
  assert.equal(probe.advertised.structuredOutput, false);
  assert.equal(probe.advertised.skipUserConfig, false);
  assert.equal(probe.productionQualified, false);
});
