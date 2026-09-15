/**
 * M4.1 — Codex scripted provider double tests.
 *
 * Mirrors `scripted-double.test.ts` (the Claude double's coverage) but
 * asserts the M4.1 distinctions:
 *  - capability snapshot reports `provider: "codex"` and
 *    `featureCount: 4`,
 *  - `startup.kind` is `"codex-scripted-double"`, not `"scripted-double"`,
 *  - `startup.metadata.bidirectionalInput === false` is the explicit
 *    non-claim M4.1 requires (codex does not advertise symmetric input).
 *
 * Coverage:
 *  - capabilities() returns the version-aware codex snapshot
 *  - spawn fills startup metadata with the distinct shape
 *  - write emits an output event per write; close exits 0
 *  - acknowledge emits one ack per previously-unacked sequence
 *  - stdin past the 4 MiB cap raises and does not emit output
 *  - disconnectOnFirstWrite emits exit code null + signal without acks
 *  - the two doubles are not interchangeable: a Claude `startup.kind`
 *    test would never match a codex handle, and vice versa
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexScriptedProviderDouble,
  DEFAULT_CODEX_CAPABILITIES,
} from "../../../src/runtime/providers/codex-scripted-double";
import { SCRIPTED_INPUT_CAP_BYTES } from "../../../src/runtime/providers/scripted-double";
import type { LifecycleEvent, SpawnRequest } from "../../../src/runtime/providers/adapter";

function collect(handle: { lifecycle: import("node:events").EventEmitter }): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  handle.lifecycle.on("event", (event: LifecycleEvent) => { events.push(event); });
  return events;
}

const baseRequest: SpawnRequest = {
  correlationId: "corr-codex-1",
  canonicalDigest: "b".repeat(64),
  providerVersion: "codex-0.0.1",
  model: "codex-default",
  accountMode: "authenticated",
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  argsJson: "{}",
  scopeJson: "{}",
  parentInvocationId: null,
};

test("capabilities returns the version-aware codex snapshot", async () => {
  const adapter = new CodexScriptedProviderDouble();
  const caps = await adapter.capabilities();
  assert.equal(caps.provider, "codex");
  assert.equal(caps.featureCount, DEFAULT_CODEX_CAPABILITIES.featureCount);
  assert.equal(caps.featureCount, 4);
  assert.ok(caps.version && /codex-scripted/.test(caps.version));
  assert.ok(caps.probedAt);
});

test("spawn fills startup metadata with the codex-distinct shape", async () => {
  const adapter = new CodexScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  assert.ok(handle.startup);
  assert.equal(handle.startup?.kind, "codex-scripted-double");
  assert.equal(handle.startup?.correlationId, baseRequest.correlationId);
  const metadata = handle.startup?.metadata as { scheme?: string; bidirectionalInput?: boolean } | undefined;
  assert.ok(metadata);
  assert.equal(metadata?.scheme, "codex");
  assert.equal(metadata?.bidirectionalInput, false);
});

test("write emits an output event per write and close exits 0", async () => {
  const adapter = new CodexScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  await handle.stdin.write(new Uint8Array([1, 2, 3, 4]));
  await handle.stdin.write(new Uint8Array([5, 6]));
  handle.stdin.close();
  await new Promise(resolve => setImmediate(resolve));
  const outputs = events.filter(e => e.kind === "output");
  assert.equal(outputs.length, 2);
  if (outputs[0] && outputs[0].kind === "output") assert.equal(outputs[0].bytes, 4);
  if (outputs[1] && outputs[1].kind === "output") assert.equal(outputs[1].bytes, 2);
  const exit = events.find(e => e.kind === "exit");
  assert.ok(exit && exit.kind === "exit");
  if (exit && exit.kind === "exit") assert.equal(exit.code, 0);
});

test("acknowledge emits one ack per previously-unacked sequence", async () => {
  const adapter = new CodexScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  await handle.stdin.write(new Uint8Array([1]));
  await handle.stdin.write(new Uint8Array([2, 3]));
  handle.acknowledge(2);
  handle.acknowledge(10); // ignored — no more unacked
  const acks = events.filter(e => e.kind === "ack");
  assert.equal(acks.length, 2);
});

test("stdin past the 4 MiB cap raises and does not emit output", async () => {
  const adapter = new CodexScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  const big = new Uint8Array(SCRIPTED_INPUT_CAP_BYTES);
  await handle.stdin.write(big);
  await assert.rejects(handle.stdin.write(new Uint8Array([1])));
  const outputs = events.filter(e => e.kind === "output");
  assert.equal(outputs.length, 1);
});

test("disconnectOnFirstWrite emits exit code null + signal without acks", async () => {
  const adapter = new CodexScriptedProviderDouble({ disconnectOnFirstWrite: true });
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  await new Promise(resolve => setImmediate(resolve));
  const exit = events.find(e => e.kind === "exit");
  assert.ok(exit && exit.kind === "exit");
  if (exit && exit.kind === "exit") {
    assert.equal(exit.code, null);
    assert.ok(exit.signal);
  }
  const acks = events.filter(e => e.kind === "ack");
  assert.equal(acks.length, 0);
});

test("codex and claude doubles produce distinct startup.kind discriminators", async () => {
  // Importing the Claude double lazily to keep the test surface local.
  const { ScriptedProviderDouble } = await import("../../../src/runtime/providers/scripted-double");
  const claude = await new ScriptedProviderDouble().spawn(baseRequest);
  const codex = await new CodexScriptedProviderDouble().spawn(baseRequest);
  assert.equal(claude.startup?.kind, "scripted-double");
  assert.equal(codex.startup?.kind, "codex-scripted-double");
  assert.notEqual(claude.startup?.kind, codex.startup?.kind);
});
