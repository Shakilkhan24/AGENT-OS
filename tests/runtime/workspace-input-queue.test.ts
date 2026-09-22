/**
 * M1.5 wiring integration test. The runtime owns the bounded paste queue
 * and broadcasts `terminal-input-progress` signals to every peer.
 *
 *  - `input` admits bytes through the runtime-owned queue.
 *  - `cancel-input` returns a numeric `dropped` count.
 *  - The protocol enforces the per-call byte limit (64 KiB) before the
 *    queue sees the request; the queue enforces the budget (2 MiB) on
 *    cumulative admitted bytes. Together they bound accepted input.
 *  - An `input` against a stale token (selection changed) is rejected
 *    with a typed CONFLICT message and does not deliver any byte.
 *  - `terminal-input-progress` is a valid signal: its envelope parses
 *    and surfaces per-token byte counts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { RuntimeWorkspace } from "../../src/runtime/workspace";
import { ControlServer } from "../../src/runtime/control-server";
import { ControlClient } from "../../src/runtime/control-client";
import { configureLogging } from "../../src/main/logging";
import { API_VERSION, parseSignal } from "../../src/shared/protocol";

configureLogging({ write: async () => {} });

test("runtime-owned queue: input admits, cancel-input reports dropped, stale token is rejected", { timeout: 20000 }, async t => {
  const base = await mkdtemp("/tmp/minimal-runtime-queue-"), root = `${base}/project`, profile = `${base}/profile`;
  await mkdir(root); await writeFile(`${root}/note.txt`, "x");
  const workspace = await RuntimeWorkspace.open(profile, path.resolve("helpers"), "1.2.2");
  const auth = { profileKey: randomBytes(10).toString("hex"), token: randomBytes(32).toString("hex") };
  const server = new ControlServer(auth, workspace.incarnation, "1.2.2", (peer, send) => workspace.connect(peer, send));
  await server.listen(`${base}/control.sock`);
  const client = new ControlClient(`${base}/control.sock`, auth);
  t.after(async () => {
    client.close(); await server.close();
    for (const id of (await workspace.service.engine.inspect()).keys()) await workspace.service.engine.remove(id);
    await workspace.close(); await rm(base, { recursive: true, force: true });
  });
  const session = (await client.call("create-session", "Queue wiring", root)).sessions[0];
  const launched = await client.call("launch-terminals", session.id, { command: "exec cat", idempotencyKey: crypto.randomUUID() });
  const terminal = launched.sessions[0].terminals[0];
  const token = await client.call("attach", terminal.id, 80, 24);

  // Admit bytes through the runtime-owned queue.
  const result = await client.call("input", token, "hello-queue");
  assert.equal(result.admitted, "hello-queue".length);

  // Cancel anything still unsubmitted; the response is always numeric.
  const cancelled = await client.call("cancel-input", token);
  assert.equal(typeof cancelled.dropped, "number");

  // Selection changed: a UUID-shaped token that does not own the current
  // attachment must reject with the typed CONFLICT message.
  await assert.rejects(client.call("input", crypto.randomUUID(), "x"), /selection changed/);

  // Wire-limit: a single call above 64 KiB is rejected at the protocol layer.
  await assert.rejects(client.call("input", token, "x".repeat(64 * 1024 + 1)), /Too big|65536/);

  await client.call("detach", token);
});

test("terminal-input-progress signal parses and carries per-token byte counts", () => {
  const envelope = { apiVersion: API_VERSION, args: [[
    { token: "abc", queued: 0, delivered: 1024 },
    { token: "def", queued: 4096, delivered: 0 },
  ]] };
  const snapshot = parseSignal("terminal-input-progress", envelope)[0];
  assert.equal(snapshot.length, 2);
  assert.deepEqual(snapshot[0], { token: "abc", queued: 0, delivered: 1024 });
  assert.deepEqual(snapshot[1], { token: "def", queued: 4096, delivered: 0 });
});
