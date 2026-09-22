import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, chmod } from "node:fs/promises";
import { createConnection } from "node:net";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { ControlServer, type RuntimeEndpoint } from "../../src/runtime/control-server";
import { ControlClient } from "../../src/runtime/control-client";
import { FrameDecoder, encodeFrame } from "../../src/runtime/framing";
import { ProtocolDispatcher } from "../../src/main/protocol-dispatcher";
import { configureLogging } from "../../src/main/logging";
import { API_VERSION, type Request } from "../../src/shared/protocol";
import type { RuntimePeer, ServerSignal } from "../../src/shared/runtime-protocol";
import { deferred } from "../support";

configureLogging({ write: async () => {} });
const credential = () => ({ profileKey: randomBytes(10).toString("hex"), token: randomBytes(32).toString("hex") });
function request(): Request {
  return { apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    method: "read-clipboard", args: [], deadlineAt: Date.now() + 30000 };
}
async function fixture(t: TestContext, factory?: (dispatcher: ProtocolDispatcher, peer: RuntimePeer, send: (message: ServerSignal) => void) => Partial<RuntimeEndpoint> | void, maxPeers = 8) {
  const root = await mkdtemp("/tmp/minimal-control-"), socket = `${root}/control.sock`, auth = credential();
  const clients: ControlClient[] = [], gates: (() => void)[] = [];
  const peers: RuntimePeer[] = [];
  const server = new ControlServer(auth, crypto.randomUUID(), "1.2.2", (peer, send) => {
    peers.push(peer);
    const dispatcher = new ProtocolDispatcher(2);
    const extra = factory?.(dispatcher, peer, send);
    return { dispatch: input => dispatcher.dispatch(input.method, input), cancel: id => dispatcher.cancel(id),
      signal: () => {}, detachView: () => {}, close: () => dispatcher.close(), ...extra };
  }, maxPeers, 500);
  await server.listen(socket);
  t.after(async () => {
    gates.forEach(release => release()); clients.forEach(client => client.close());
    await server.close(); await rm(root, { recursive: true, force: true });
  });
  const client = (credentials = auth, changed?: (message: ServerSignal) => void) => {
    const result = new ControlClient(socket, credentials, changed); clients.push(result); return result;
  };
  return { root, socket, auth, server, client, peers, gates };
}

test("authenticated Unix socket requests preserve IDs, typed results and server-owned scope", async t => {
  let seen: Request | undefined;
  const f = await fixture(t, (dispatcher, _peer, send) => {
    dispatcher.register("read-clipboard", () => "বাংলা 🌍");
    return { dispatch: async input => {
      seen = input;
      send({ type: "signal", name: "workspace-changed", envelope: { apiVersion: API_VERSION, args: [] } });
      return dispatcher.dispatch(input.method, input);
    } };
  });
  let signals = 0;
  const client = f.client(f.auth, () => { signals++; });
  const welcome = await client.ready;
  assert.equal(welcome.incarnation, f.server.incarnation);
  assert.equal((await stat(f.socket)).mode & 0o777, 0o600);
  const input = request(), response = await client.dispatch(input);
  assert.deepEqual(seen, input);
  assert.equal(response.id, input.id); assert.equal(response.ok, true);
  if (response.ok) assert.equal(response.result, "বাংলা 🌍");
  assert.equal(signals, 1);
  assert.equal(f.peers[0].principal, "desktop"); assert.equal(f.peers[0].profileKey, f.auth.profileKey);
  assert.equal(Object.isFrozen(f.peers[0]), true);
});

test("wrong token/profile and stale API versions cannot create an operation endpoint", async t => {
  const f = await fixture(t);
  await assert.rejects(f.client({ ...f.auth, token: randomBytes(32).toString("hex") }).ready, /authentication failed/);
  await assert.rejects(f.client({ ...f.auth, profileKey: randomBytes(10).toString("hex") }).ready, /authentication failed/);
  const socket = createConnection(f.socket); socket.on("error", () => {});
  t.after(() => socket.destroy());
  const received: unknown[] = [], decoder = new FrameDecoder(value => received.push(value));
  socket.on("data", data => decoder.push(typeof data === "string" ? Buffer.from(data) : data));
  const closed = once(socket, "close");
  socket.write(encodeFrame({ type: "authenticate", apiVersion: 99, ...f.auth }));
  await closed;
  assert.match(JSON.stringify(received), /VERSION_MISMATCH/);
  assert.equal(f.peers.length, 0);
});

test("cancellation is scoped to a connection even when request IDs coincide", async t => {
  const entered = deferred(), gate = deferred(); let operations = 0, cancellations = 0;
  const f = await fixture(t, dispatcher => {
    dispatcher.register("read-clipboard", async (_args, context) => {
      operations++; context.signal.addEventListener("abort", () => { cancellations++; });
      entered.resolve(); await gate.promise; return "done";
    });
  });
  f.gates.push(gate.resolve);
  const first = f.client(), second = f.client(); await Promise.all([first.ready, second.ready]);
  const input = request(), pending = first.dispatch(input); await entered.promise;
  second.cancel(input.id);
  // A response on the second connection establishes that its cancellation was consumed.
  const other = second.dispatch(input); gate.resolve();
  const [one, two] = await Promise.all([pending, other]);
  assert.equal(one.ok, true); assert.equal(two.ok, true);
  assert.equal(cancellations, 0); assert.equal(operations, 2);
});

test("disconnect does not replay accepted work and server shutdown drains it", async t => {
  const entered = deferred(), gate = deferred(); let effects = 0;
  const f = await fixture(t, dispatcher => {
    dispatcher.register("read-clipboard", async () => { effects++; entered.resolve(); await gate.promise; return "finished"; });
  });
  f.gates.push(gate.resolve);
  const client = f.client(), pending = client.dispatch(request()); await entered.promise;
  client.close();
  await assert.rejects(pending, error => (error as { failure: { outcomeUnknown: boolean } }).failure.outcomeUnknown === true);
  let drained = false;
  const stopping = f.server.close().then(() => { drained = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(drained, false);
  gate.resolve(); await stopping; assert.equal(effects, 1);
});

test("request expiry cancels the handler without claiming its completed effect was undone", async t => {
  const entered = deferred(), cancelled = deferred(), gate = deferred();
  const f = await fixture(t, dispatcher => {
    dispatcher.register("read-clipboard", async (_args, context) => {
      context.signal.addEventListener("abort", cancelled.resolve); entered.resolve(); await gate.promise; return "finished";
    });
  });
  f.gates.push(gate.resolve);
  const client = f.client(); await client.ready;
  const input = request(); input.deadlineAt = Date.now() + 100;
  const result = client.dispatch(input).then(response => response.ok ? null : response.error, error => error.failure);
  await entered.promise; const failure = await result;
  assert.equal(failure.code, "TIMEOUT"); assert.equal(failure.outcomeUnknown, true);
  await cancelled.promise; gate.resolve();
});

test("unauthenticated peers have a deadline and a smaller frame budget", async t => {
  const f = await fixture(t);
  for (const oversized of [false, true]) {
    const socket = createConnection(f.socket); socket.on("error", () => {});
    t.after(() => socket.destroy()); const closed = once(socket, "close");
    if (oversized) { const header = Buffer.alloc(4); header.writeUInt32BE(65537); socket.write(header); }
    await closed;
  }
  assert.equal(f.peers.length, 0);
});

test("listener refuses shared directories and never unlinks a live socket", async t => {
  const f = await fixture(t);
  const second = new ControlServer(f.auth, crypto.randomUUID(), "1.2.2", () => { throw new Error("unused"); });
  t.after(() => second.close());
  await assert.rejects(second.listen(f.socket), /EADDRINUSE/);
  await chmod(f.root, 0o755);
  await assert.rejects(second.listen(`${f.root}/other.sock`), /not private/);
  await chmod(f.root, 0o700);
  await f.client().ready;
});
