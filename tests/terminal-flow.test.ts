import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { TerminalInputQueue, utf8Bytes } from "../src/shared/terminal-flow";
import { deferred } from "./support";

test("UTF-8 budgeting accounts for multibyte and astral text", async () => {
  const sent: string[] = [];
  const queue = new TerminalInputQueue(async data => { sent.push(data); }, 8);
  assert.equal(utf8Bytes("λ😀"), 6);
  await assert.rejects(queue.enqueue("😀😀😀"), /too large/);
  await queue.enqueue("λ😀");
  assert.deepEqual(sent, ["λ😀"]);
});

test("input waits for delivery; cancellation drops remaining chunks and queued commands", async () => {
  const started = deferred(), release = deferred();
  const sent: string[] = [];
  const queue = new TerminalInputQueue(async chunk => { sent.push(chunk); started.resolve(); await release.promise; });
  const first = queue.enqueue("λ".repeat(20000));
  const second = queue.enqueue("do not replay\r");
  const checks = [assert.rejects(first, /cancelled/), assert.rejects(second, /cancelled/)];
  await started.promise; await setImmediate();
  assert.equal(sent.length, 1);
  queue.cancel(); release.resolve();
  await Promise.all(checks);
  assert.equal(sent.length, 1);
});

test("delivery failures are surfaced without retrying or poisoning future input", async () => {
  let fail = true;
  const sent: string[] = [];
  const queue = new TerminalInputQueue(async chunk => {
    if (fail) throw new Error("pipe closed");
    sent.push(chunk);
  });
  await assert.rejects(queue.enqueue("old"), /pipe closed/);
  fail = false; await queue.enqueue("new");
  assert.deepEqual(sent, ["new"]);
});

test("chunks preserve Unicode surrogate pairs and the byte budget includes active delivery", async () => {
  const release = deferred();
  const sent: string[] = [];
  const text = "a".repeat(16383) + "😀" + "b";
  const queue = new TerminalInputQueue(async chunk => { sent.push(chunk); await release.promise; }, utf8Bytes(text));
  const pending = queue.enqueue(text);
  await assert.rejects(queue.enqueue("x"), /busy/);
  release.resolve(); await pending;
  assert.equal(sent.join(""), text);
  assert.ok(sent.every(chunk => !chunk.endsWith("\ud83d")));
});
