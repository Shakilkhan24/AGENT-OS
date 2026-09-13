import test from "node:test";
import assert from "node:assert/strict";
import { API_VERSION, parseRequest, unwrap, parseResult, parseSignal, MAX_FRAME_BYTES, checkFrame, type Request } from "../src/shared/protocol";
import { ProtocolDispatcher } from "../src/main/protocol-dispatcher";
import { deferred } from "./support";
import { configureLogging } from "../src/main/logging";

configureLogging({ write: async () => {} });
function request(overrides: Partial<Request> = {}): Request {
  return { apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    method: "write-clipboard", deadlineAt: Date.now() + 30000, args: ["value"], ...overrides };
}
test("protocol rejects mismatched versions, methods, invalid payloads and expired requests before effects", async () => {
  const dispatcher = new ProtocolDispatcher(); let effects = 0;
  dispatcher.register("write-clipboard", () => { effects++; });
  for (const input of [request({ apiVersion: 99 }), request({ args: [123] }), request({ deadlineAt: 0 }), request({ method: "snapshot", args: [] })]) {
    const response = await dispatcher.dispatch("write-clipboard", input);
    assert.equal(response.ok, false);
  }
  assert.equal(effects, 0);
  assert.throws(() => parseRequest(request({ deadlineAt: Date.now() + 3600000 })));
});
test("responses must match their request and file action, and frame limits count UTF-8 bytes", () => {
  const input = request();
  assert.throws(() => unwrap(input, ["value"], { apiVersion: 1, id: crypto.randomUUID(), ok: true }));
  assert.throws(() => unwrap(input, ["value"], { apiVersion: 99, id: input.id, ok: true }));
  assert.throws(() => parseResult("files", [crypto.randomUUID(), { action: "preview", path: "file" }], "wrong read-result shape"));
  assert.throws(() => checkFrame("🌍".repeat(MAX_FRAME_BYTES / 4)), /byte limit/);
  assert.throws(() => checkFrame(1n), /serializable/);
  assert.throws(() => checkFrame(undefined), /serializable/);
});
test("invalid handler output reports an uncertain outcome after the operation ran", async () => {
  const dispatcher = new ProtocolDispatcher(); let effects = 0;
  dispatcher.register("read-clipboard", () => { effects++; return "x".repeat(2 * 1024 * 1024 + 1); });
  const response = await dispatcher.dispatch("read-clipboard", request({ method: "read-clipboard", args: [] }));
  assert.equal(effects, 1);
  assert.equal(response.ok, false);
  if (!response.ok) { assert.equal(response.error.code, "INTERNAL"); assert.equal(response.error.outcomeUnknown, true); }
  await dispatcher.close();
});
test("terminal signals validate their version, attachment identity and payload bounds", () => {
  const token = crypto.randomUUID();
  assert.deepEqual(parseSignal("resize", { apiVersion: 1, args: [token, 80, 24] }), [token, 80, 24]);
  assert.throws(() => parseSignal("resize", { apiVersion: 99, args: [token, 80, 24] }), /Incompatible/);
  assert.throws(() => parseSignal("acknowledge", { apiVersion: 1, args: [token, -1] }));
  assert.throws(() => parseSignal("terminal-output", { apiVersion: 1, args: ["wrong token", "text"] }));
});
test("deadlines signal cancellation, report uncertainty and retain admission until the operation settles", async () => {
  const dispatcher = new ProtocolDispatcher(1), gate = deferred();
  let cancelled = false;
  dispatcher.register("write-clipboard", async (_args, context) => {
    context.signal.addEventListener("abort", () => { cancelled = true; });
    await gate.promise;
  });
  const input = request({ deadlineAt: Date.now() + 30 });
  const response = await dispatcher.dispatch("write-clipboard", input);
  assert.equal(response.ok, false);
  if (!response.ok) { assert.equal(response.error.code, "TIMEOUT"); assert.equal(response.error.outcomeUnknown, true); }
  assert.equal(cancelled, true);
  const busy = await dispatcher.dispatch("write-clipboard", request());
  assert.equal(busy.ok, false); if (!busy.ok) assert.equal(busy.error.code, "BUSY");
  let drained = false; const close = dispatcher.close().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  gate.resolve(); await close;
});
test("explicit cancellation and duplicate IDs cannot spawn a second operation", async () => {
  const dispatcher = new ProtocolDispatcher(), entered = deferred(), gate = deferred();
  let effects = 0;
  dispatcher.register("write-clipboard", async () => { effects++; entered.resolve(); await gate.promise; });
  const input = request(), pending = dispatcher.dispatch("write-clipboard", input); await entered.promise;
  const duplicate = await dispatcher.dispatch("write-clipboard", input);
  assert.equal(duplicate.ok, false); if (!duplicate.ok) assert.equal(duplicate.error.code, "CONFLICT");
  dispatcher.cancel(input.id);
  const response = await pending;
  assert.equal(response.ok, false); if (!response.ok) assert.equal(response.error.code, "CANCELLED");
  assert.equal(effects, 1); gate.resolve(); await dispatcher.close();
});
test("pending admission is bounded by encoded bytes as well as operation count", async () => {
  const input = request({ args: ["🌍".repeat(100)] }), gate = deferred();
  const bytes = Buffer.byteLength(JSON.stringify(input));
  const dispatcher = new ProtocolDispatcher(128, bytes);
  dispatcher.register("write-clipboard", async () => { await gate.promise; });
  const first = dispatcher.dispatch("write-clipboard", input);
  const busy = await dispatcher.dispatch("write-clipboard", request({ args: ["a"] }));
  assert.equal(busy.ok, false); if (!busy.ok) assert.equal(busy.error.code, "BUSY");
  gate.resolve(); await first;
  const next = await dispatcher.dispatch("write-clipboard", request({ args: ["b"] }));
  assert.equal(next.ok, true); await dispatcher.close();
});
