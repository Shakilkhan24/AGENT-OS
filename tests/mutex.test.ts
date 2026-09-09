import test from "node:test";
import assert from "node:assert/strict";
import { Mutex } from "../src/main/mutex";
test("mutex preserves order, cancels queued work, bounds waiters and releases after failure", async () => {
  const mutex = new Mutex(2);
  let release!: () => void;
  const order: number[] = [];
  const first = mutex.run(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    order.push(1);
  });
  const cancelled = new AbortController();
  const second = mutex.run(async () => {
    order.push(2);
  }, cancelled.signal);
  const third = mutex.run(async () => {
    order.push(3);
    throw new Error("expected");
  });
  await assert.rejects(
    mutex.run(async () => {}),
    /full/,
  );
  cancelled.abort();
  await assert.rejects(second, /cancelled/);
  const failed = assert.rejects(third, /expected/);
  release();
  await first;
  await failed;
  await mutex.run(async () => {
    order.push(4);
  });
  assert.deepEqual(order, [1, 3, 4]);
});
