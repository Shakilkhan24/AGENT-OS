/**
 * M3b Increment 1 — scripted provider double tests.
 *
 * Coverage:
 *  - spawn → started → write → output → close → exit
 *  - byte-budgeted stdin (4 MiB cap) refuses past-cap writes
 *  - acknowledge advances the ack counter; previously-acked seqs are not re-emitted
 *  - disconnectOnFirstWrite triggers the orchestrator's `markAmbiguous` path
 *    (exit code null + signal + never acked).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ScriptedProviderDouble, SCRIPTED_INPUT_CAP_BYTES } from "../../../src/runtime/providers/scripted-double";
import type { LifecycleEvent, SpawnRequest } from "../../../src/runtime/providers/adapter";

function collect(handle: { lifecycle: import("node:events").EventEmitter }): LifecycleEvent[] {
  const events: LifecycleEvent[] = [];
  handle.lifecycle.on("event", (event: LifecycleEvent) => { events.push(event); });
  return events;
}

const baseRequest: SpawnRequest = {
  correlationId: "corr-1",
  canonicalDigest: "a".repeat(64),
  providerVersion: "p1",
  model: "m1",
  accountMode: "authenticated",
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  argsJson: "{}",
  scopeJson: "{}",
  parentInvocationId: null,
};

test("spawn fills startup metadata synchronously; close emits exit code 0", async () => {
  const adapter = new ScriptedProviderDouble();
  const events: LifecycleEvent[] = [];
  const handle = await adapter.spawn(baseRequest);
  // The scripted double surfaces started via `startup` (synchronous), not
  // a lifecycle event (which would race against the listener subscription).
  assert.ok(handle.startup);
  assert.equal(handle.startup?.kind, "scripted-double");
  handle.lifecycle.on("event", (e: LifecycleEvent) => { events.push(e); });
  handle.stdin.close();
  await new Promise(resolve => setImmediate(resolve));
  const exit = events.find(e => e.kind === "exit");
  assert.ok(exit);
  assert.equal(exit?.kind, "exit");
  if (exit && exit.kind === "exit") assert.equal(exit.code, 0);
});

test("write emits an output event per write and close exits 0", async () => {
  const adapter = new ScriptedProviderDouble();
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
});

test("acknowledge emits one ack per previously-unacked sequence", async () => {
  const adapter = new ScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  await handle.stdin.write(new Uint8Array([1]));
  await handle.stdin.write(new Uint8Array([2, 3]));
  handle.acknowledge(2);
  handle.acknowledge(10); // should be ignored — no more unacked
  const acks = events.filter(e => e.kind === "ack");
  assert.equal(acks.length, 2);
});

test("stdin past the 4 MiB cap raises and does not emit output", async () => {
  const adapter = new ScriptedProviderDouble();
  const handle = await adapter.spawn(baseRequest);
  const events = collect(handle);
  // Saturate the queue.
  const big = new Uint8Array(SCRIPTED_INPUT_CAP_BYTES);
  await handle.stdin.write(big);
  await assert.rejects(handle.stdin.write(new Uint8Array([1])));
  const outputs = events.filter(e => e.kind === "output");
  assert.equal(outputs.length, 1);
});

test("disconnectOnFirstWrite emits an exit code null + signal without acks", async () => {
  const adapter = new ScriptedProviderDouble({ disconnectOnFirstWrite: true });
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