import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { RuntimeWorkspace } from "../../src/runtime/workspace";
import { ControlServer } from "../../src/runtime/control-server";
import { ControlClient } from "../../src/runtime/control-client";
import { configureLogging } from "../../src/main/logging";
import { serviceFixture, deferred, ownedDbFixture } from "../support";
import { DraftStore } from "../../src/main/draft-store";
import { defaultSettings } from "../../src/shared/settings";
import { API_VERSION, type Request } from "../../src/shared/protocol";

configureLogging({ write: async () => {} });

test("headless socket workflow edits files, restores drafts and reconnects to the same tmux process", { timeout: 20000 }, async t => {
  const base = await mkdtemp("/tmp/minimal-runtime-workspace-"), root = `${base}/project`, profile = `${base}/profile`;
  await mkdir(root); await writeFile(`${root}/note.txt`, "original");
  let workspace = await RuntimeWorkspace.open(profile, path.resolve("helpers"), "1.2.2");
  const auth = { profileKey: randomBytes(10).toString("hex"), token: randomBytes(32).toString("hex") };
  let server = new ControlServer(auth, workspace.incarnation, "1.2.2", (peer, send) => workspace.connect(peer, send));
  await server.listen(`${base}/control.sock`);
  let client = new ControlClient(`${base}/control.sock`, auth);
  t.after(async () => {
    client.close(); await server.close();
    for (const id of (await workspace.service.engine.inspect()).keys()) await workspace.service.engine.remove(id);
    await workspace.close(); await rm(base, { recursive: true, force: true });
  });
  const session = (await client.call("create-session", "Headless project", root)).sessions[0];
  const launched = await client.call("launch-terminals", session.id, { command: "exec sleep 600", idempotencyKey: crypto.randomUUID() });
  const terminal = launched.sessions[0].terminals[0];
  assert.equal(terminal.status, "running"); assert.ok(terminal.pid);
  const firstView = await client.call("attach", terminal.id, 80, 24);
  const observer = new ControlClient(`${base}/control.sock`, auth);
  t.after(() => observer.close());
  await assert.rejects(observer.call("input", firstView, " "), /selection changed/);
  const secondView = await observer.call("attach", terminal.id, 100, 30);
  await assert.rejects(client.call("input", firstView, " "), /selection changed/);
  await client.call("detach", firstView);
  // An obsolete view cannot resize or close the replacement observer.
  client.signal({ type: "signal", name: "resize", envelope: { apiVersion: API_VERSION, args: [firstView, 10, 10] } });
  await observer.call("input", secondView, " ");
  const expectedHash = createHash("sha256").update("original").digest("hex");
  const saved = await client.call("files", session.id, { action: "write", path: "note.txt", expectedHash, content: "বাংলা 🌍" });
  assert.ok(saved && typeof saved === "object" && "saved" in saved && saved.saved);
  await client.call("save-draft", { sessionId: session.id, path: "note.txt", baseHash: expectedHash, content: "unsaved recovery" });
  assert.equal(await readFile(`${root}/note.txt`, "utf8"), "বাংলা 🌍");
  await assert.rejects(client.call("write-clipboard", "not a runtime operation"), /not available/);
  await assert.rejects(client.call("files", session.id, { action: "read", path: "../outside" }));
  const first = await client.ready;
  client.close();
  await observer.call("input", secondView, " ");
  observer.close(); await server.close(); await workspace.close();
  // Restart the domain owner with the same profile, without replaying the command.
  workspace = await RuntimeWorkspace.open(profile, path.resolve("helpers"), "1.2.2");
  server = new ControlServer(auth, workspace.incarnation, "1.2.2", (peer, send) => workspace.connect(peer, send));
  await server.listen(`${base}/control.sock`);
  client = new ControlClient(`${base}/control.sock`, auth);
  assert.notEqual((await client.ready).incarnation, first.incarnation);
  const reopened = await client.call("snapshot");
  assert.equal(reopened.sessions[0].terminals[0].pid, terminal.pid);
  const drafts = await client.call("list-drafts");
  assert.equal((await client.call("read-draft", drafts[0].id)).content, "unsaved recovery");
  await client.call("delete-terminal", session.id, terminal.id);
  assert.equal((await client.call("snapshot")).sessions[0].terminals.length, 0);
});

test("disconnect drains an accepted batch without cancelling its later members", { timeout: 10000 }, async t => {
  const f = await serviceFixture(), entered = deferred(), gate = deferred();
  const ownedDb = await ownedDbFixture();
  const workspace = new RuntimeWorkspace(f.service, new DraftStore(f.store.directory), defaultSettings, null, "1.2.2", ownedDb, {
    bootId: "test-boot",
    bootedAtIso: new Date().toISOString(),
    monotonicBasisMs: "0",
    pid: process.pid,
    nodeVersion: process.version,
  });
  t.after(async () => { gate.resolve(); await workspace.close(); await ownedDb.close(); await f.cleanup(); });
  f.engine.beforeCreate = async () => { entered.resolve(); await gate.promise; };
  const endpoint = workspace.connect({ connectionId: crypto.randomUUID(), profileKey: "a".repeat(20), principal: "desktop" }, () => {});
  const request: Request = { apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    method: "launch-terminals", args: [f.session.id, { command: "worker", count: 3 }], deadlineAt: Date.now() + 30000 };
  const launch = endpoint.dispatch(request); await entered.promise;
  let closed = false; const closing = endpoint.close().then(() => { closed = true; });
  await Promise.resolve(); assert.equal(closed, false);
  gate.resolve(); const response = await launch; await closing;
  assert.equal(response.ok, true); assert.equal(f.engine.created.length, 3); assert.equal(f.engine.removed.length, 0);
});
