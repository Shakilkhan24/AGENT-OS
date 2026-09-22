import test from "node:test";
import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { FrameConnection } from "../../src/runtime/connection";
import { encodeFrame } from "../../src/runtime/framing";

/** A stalled writable models a socket whose peer never drains its receive buffer. */
class StalledSocket extends Duplex {
  _read() {}
  _write(_chunk: Buffer, _encoding: BufferEncoding, _done: (error?: Error | null) => void) {}
}
test("a slow peer cannot grow the outbound queue without a byte bound", async () => {
  const socket = new StalledSocket(); let closed!: (error: Error) => void;
  const failure = new Promise<Error>(resolve => { closed = resolve; });
  const connection = new FrameConnection(socket, () => {}, closed, () => 1024, 1000, 80);
  connection.send("🌍".repeat(10));
  assert.equal(socket.writableLength, encodeFrame("🌍".repeat(10)).length);
  assert.throws(() => connection.send("🌍".repeat(10)), /not consuming/);
  assert.match((await failure).message, /not consuming/);
});

test("partial frame timeout is bounded and an idle complete connection stays open", { timeout: 1000 }, async () => {
  const socket = new StalledSocket(); let closed!: (error: Error) => void;
  const failure = new Promise<Error>(resolve => { closed = resolve; });
  const received: unknown[] = [];
  new FrameConnection(socket, value => received.push(value), closed, () => 1024, 25);
  socket.push(encodeFrame({ complete: true }));
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(received, [{ complete: true }]); assert.equal(socket.destroyed, false);
  socket.push(Buffer.from([0, 0]));
  assert.match((await failure).message, /Incomplete runtime frame timed out/);
});

test("a torn stream reports failure rather than receiving truncated JSON", async () => {
  const socket = new StalledSocket(); let closed!: (error: Error) => void;
  const failure = new Promise<Error>(resolve => { closed = resolve; });
  new FrameConnection(socket, () => assert.fail("partial JSON was received"), closed);
  socket.push(Buffer.from([0, 0, 0, 8, 123])); socket.push(null);
  socket.once("end", () => socket.destroy());
  assert.match((await failure).message, /inside a frame/);
});

test("completed frames renew the partial-frame deadline during a continuous fragmented stream", { timeout: 2000 }, async t => {
  const socket = new StalledSocket(), received: unknown[] = [];
  const connection = new FrameConnection(socket, value => received.push(value), () => {}, () => 1024, 60);
  t.after(() => connection.destroy());
  const frame = encodeFrame({ text: "healthy stream" });
  socket.push(frame.subarray(0, 2));
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    // Every socket chunk finishes one frame and starts the next one.
    socket.push(Buffer.concat([frame.subarray(2), frame.subarray(0, 2)]));
    assert.equal(socket.destroyed, false, "completed frames must not inherit an older deadline");
  }
  socket.push(frame.subarray(2));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(received.length, 11);
});
