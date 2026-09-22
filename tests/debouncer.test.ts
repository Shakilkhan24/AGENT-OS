import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { Debouncer } from "../src/main/debouncer";
import { deferred } from "./support";

test("flush and close wait for active writes, rejecting new work while closing", async () => {
  const started = deferred(), release = deferred();
  const writer = new Debouncer(async () => { started.resolve(); await release.promise; }, 0);
  const scheduled = writer.schedule(undefined);
  await started.promise;
  let flushed = false, closed = false;
  const flush = writer.flush().then(() => { flushed = true; });
  const close = writer.close().then(() => { closed = true; });
  await setImmediate();
  assert.equal(flushed, false); assert.equal(closed, false);
  assert.throws(() => writer.schedule(undefined), /closed/);
  release.resolve();
  await Promise.all([scheduled, flush, close]);
});

test("an active writer cannot be overtaken by newer coalesced values", async () => {
  const started = deferred(), release = deferred();
  const seen: number[] = [];
  const writer = new Debouncer<number>(async value => {
    if (value === 1) { started.resolve(); await release.promise; }
    seen.push(value);
  }, 0);
  const first = writer.schedule(1);
  await started.promise;
  const second = writer.schedule(2), third = writer.schedule(3);
  const flushed = writer.flush();
  await setImmediate(); assert.deepEqual(seen, []);
  release.resolve();
  await Promise.all([first, second, third, flushed, writer.close()]);
  assert.deepEqual(seen, [1, 3]);
});

test("writer failures propagate through schedule, flush and repeated close", async () => {
  const writer = new Debouncer(async () => { throw new Error("disk full"); }, 60_000);
  const scheduled = assert.rejects(writer.schedule(undefined), /disk full/);
  await assert.rejects(writer.flush(), /disk full/);
  await scheduled;
  await assert.rejects(writer.close(), /disk full/);
  await assert.rejects(writer.close(), /disk full/);
});

test("a successful retry makes the newest value durable after a write failure", async () => {
  const seen: number[] = [];
  const writer = new Debouncer<number>(async n => {
    if (!n) throw new Error("transient error");
    seen.push(n);
  }, 0);
  await assert.rejects(writer.schedule(0));
  await writer.schedule(1); await writer.close();
  assert.deepEqual(seen, [1]);
});
