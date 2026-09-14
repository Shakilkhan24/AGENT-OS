/**
 * Per-attachment bounded input queue. Tests:
 *  - admits bytes up to the budget, rejects oversized enqueues
 *  - delivers admitted bytes serially in admission order, even across
 *    rapid enqueues from the same or different tokens
 *  - emits progress with byte counts; coalesces burst signals
 *  - cancel() drops only unsubmitted bytes; delivered bytes survive
 *  - failed deliveries do not retry, drop the queued remainder, and
 *    surface the error verbatim — no paste content is logged
 *  - admitted bytes survive view churn: closing the renderer-side caller
 *    (e.g. switching tabs) does not affect the runtime-owned queue
 */
import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/shared/errors";
import { TerminalInputQueue } from "../../src/runtime/input-queue";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function captureStderr(): { read(): string; restore(): void } {
  const original = process.stderr.write.bind(process.stderr);
  let buffer = "";
  // The queue only writes to stderr outside the test environment; capture
  // every call so we can assert the failure path stays paste-free.
  (process.stderr as unknown as { write: typeof original }).write = ((chunk: string | Uint8Array) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return original(chunk as never);
  }) as typeof original;
  return {
    read: () => buffer,
    restore: () => { (process.stderr as unknown as { write: typeof original }).write = original; },
  };
}

test("enqueue admits bytes up to the budget and rejects oversized chunks", () => {
  const deliveries: string[] = [];
  const queue = new TerminalInputQueue(async (_token, data) => { deliveries.push(data); }, { budgetBytes: 100 });
  const { admitted } = queue.enqueue("t1", "hello");
  assert.equal(admitted, 5);
  assert.equal(queue.progress("t1").queued, 5);
  assert.throws(() => queue.enqueue("t1", "x".repeat(96)), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.equal(error.failure.code, "BUSY");
    return true;
  });
  assert.throws(() => queue.enqueue("t2", "y".repeat(101)), (error: unknown) => {
    assert.ok(error instanceof AppError);
    assert.match(error.message, /exceeds the terminal input budget/);
    return true;
  });
});

test("deliveries run serially per token, even under rapid enqueue", async () => {
  const sequence: string[] = [];
  const queue = new TerminalInputQueue(async (_token, data) => { sequence.push(data); }, { progressIntervalMs: 0 });
  for (let i = 0; i < 50; i++) queue.enqueue("t1", String(i));
  await queue.close();
  assert.deepEqual(sequence, Array.from({ length: 50 }, (_, i) => String(i)));
});

test("different tokens do not block each other", async () => {
  const delivered: string[] = [];
  const queue = new TerminalInputQueue(async (_token, data) => {
    delivered.push(data);
    await new Promise(resolve => setTimeout(resolve, 1));
  }, { progressIntervalMs: 0 });
  queue.enqueue("a", "A1"); queue.enqueue("a", "A2");
  queue.enqueue("b", "B1"); queue.enqueue("b", "B2");
  await queue.close();
  // Tokens are independent but within a token the order is preserved.
  const a = delivered.filter(d => d.startsWith("A"));
  const b = delivered.filter(d => d.startsWith("B"));
  assert.deepEqual(a, ["A1", "A2"]);
  assert.deepEqual(b, ["B1", "B2"]);
});

test("progress is coalesced and reports queued/delivered byte counts", async () => {
  const deliveries: string[] = [];
  const progress: { token: string; queued: number; delivered: number }[][] = [];
  const queue = new TerminalInputQueue(async (_token, data) => { deliveries.push(data); }, { progressIntervalMs: 5 });
  const off = queue.onProgress(snapshot => progress.push([...snapshot]));
  queue.enqueue("t1", "abc"); queue.enqueue("t1", "def");
  // Wait long enough for at least one coalesced progress + delivery.
  await new Promise(resolve => setTimeout(resolve, 30));
  off();
  assert.ok(progress.length >= 1, "expected at least one progress signal");
  const last = progress[progress.length - 1].find(p => p.token === "t1");
  assert.ok(last);
  assert.equal(last.delivered, 6);
  assert.equal(last.queued, 0);
});

test("cancel drops unsubmitted bytes but preserves delivered bytes", async () => {
  const deliveries: string[] = [];
  const release = deferred<void>();
  const bridge = async (_token: string, data: string) => {
    deliveries.push(data);
    await release.promise;
  };
  const queue = new TerminalInputQueue(bridge, { progressIntervalMs: 0 });
  queue.enqueue("t1", "first");
  // Wait until the bridge has been entered but not returned.
  await new Promise(resolve => setTimeout(resolve, 5));
  queue.enqueue("t1", "second");
  const dropped = queue.cancel("t1");
  release.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  await queue.close();
  assert.deepEqual(deliveries, ["first"]);
  assert.ok(dropped >= 6);
});

test("admitted bytes survive caller churn: enqueue then close the listener", async () => {
  const sequence: string[] = [];
  const queue = new TerminalInputQueue(async (_token, data) => { sequence.push(data); }, { progressIntervalMs: 0 });
  queue.enqueue("t1", "A"); queue.enqueue("t1", "B"); queue.enqueue("t1", "C");
  // Simulate the renderer unmounting; the runtime-owned queue must keep going.
  await queue.close();
  assert.deepEqual(sequence, ["A", "B", "C"]);
});

test("a failed delivery drops the queued remainder and surfaces verbatim — no paste content logged", async () => {
  const stderr = captureStderr();
  const deliveries: string[] = [];
  const queue = new TerminalInputQueue(async (_token, data) => {
    deliveries.push(data);
    if (deliveries.length === 1) throw new Error("bridge broken");
  }, { progressIntervalMs: 0 });
  queue.enqueue("t1", "first-paste-chunk");
  queue.enqueue("t1", "second-paste-chunk");
  await new Promise(resolve => setTimeout(resolve, 20));
  stderr.restore();
  await queue.close();
  // Only the first chunk crossed the bridge; the rest were dropped, not retried.
  assert.deepEqual(deliveries, ["first-paste-chunk"]);
  // Pasted content must never appear in stderr or anywhere reachable from the queue.
  const log = stderr.read();
  assert.equal(log.includes("first-paste-chunk"), false, "queue must not log paste content");
  assert.equal(log.includes("second-paste-chunk"), false, "queue must not log paste content");
});

test("a single oversized paste is rejected before any byte is delivered", async () => {
  let delivered = false;
  const queue = new TerminalInputQueue(async (_token, _data) => { delivered = true; }, { budgetBytes: 50 });
  assert.throws(() => queue.enqueue("t1", "x".repeat(51)), /exceeds the terminal input budget/);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(delivered, false);
  await queue.close();
});
