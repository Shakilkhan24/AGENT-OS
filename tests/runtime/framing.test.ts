import test from "node:test";
import assert from "node:assert/strict";
import { FrameDecoder, encodeFrame } from "../../src/runtime/framing";

test("framing preserves coalesced messages and every byte split of Unicode payloads", () => {
  const values = [{ text: "α🌍\nnext" }, { ok: true, result: null }];
  const bytes = Buffer.concat(values.map(value => encodeFrame(value)));
  for (let split = 1; split < bytes.length; split++) {
    const seen: unknown[] = [], decoder = new FrameDecoder(value => seen.push(value));
    decoder.push(bytes.subarray(0, split)); decoder.push(bytes.subarray(split)); decoder.end();
    assert.deepEqual(seen, values);
  }
  const seen: unknown[] = [], decoder = new FrameDecoder(value => seen.push(value));
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  decoder.end(); assert.deepEqual(seen, values);
});

test("framing rejects oversized headers before bodies and poisons malformed or torn streams", () => {
  const oversized = Buffer.alloc(4); oversized.writeUInt32BE(1025);
  const decoder = new FrameDecoder(() => assert.fail("must not receive a frame"), () => 1024);
  assert.throws(() => decoder.push(oversized), /limit/);
  assert.throws(() => decoder.push(encodeFrame({})), /closed/);
  for (const bytes of [Buffer.from([0, 0]), Buffer.from([0, 0, 0, 8, 123])]) {
    const partial = new FrameDecoder(() => assert.fail("must not receive a partial frame"));
    partial.push(bytes); assert.throws(() => partial.end(), /inside a frame/);
  }
  for (const bytes of [Buffer.from([0, 0, 0, 1, 0xff]), Buffer.from([0, 0, 0, 1, 123]), Buffer.alloc(4)]) {
    const invalid = new FrameDecoder(() => assert.fail("must not receive invalid data"));
    assert.throws(() => invalid.push(bytes));
  }
});

test("framing supports a tighter authentication budget and counts encoded bytes", () => {
  let authenticated = false; const received: unknown[] = [];
  const decoder = new FrameDecoder(value => { received.push(value); authenticated = true; }, () => authenticated ? 4096 : 16);
  decoder.push(Buffer.concat([encodeFrame({ auth: true }), encodeFrame({ text: "α".repeat(1000) })]));
  assert.equal(received.length, 2);
  assert.throws(() => encodeFrame("🌍", 5), /limit/);
  assert.throws(() => encodeFrame(undefined), /serializable/);
  assert.throws(() => encodeFrame(1n), /serializable/);
});
