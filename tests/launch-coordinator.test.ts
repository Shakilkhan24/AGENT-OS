import test from "node:test";
import assert from "node:assert/strict";
import { deferred, serviceFixture } from "./support";
import { SessionService } from "../src/main/service";
import { setImmediate } from "node:timers/promises";
import { Store } from "../src/main/store";
import { EventBus } from "../src/main/event-bus";

test("request cancellation preserves the current launch item and cancels later items", async t => {
  const f = await serviceFixture();
  const entered = deferred(), release = deferred();
  t.after(async () => { release.resolve(); await f.cleanup(); });
  f.engine.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const controller = new AbortController();
  const pending = f.service.launchTerminals(f.session.id, { command: "worker", count: 3 }, controller.signal);
  await entered.promise; controller.abort(); release.resolve();
  const result = await pending;
  assert.equal(result.launches![0].state, "cancelled");
  assert.equal(f.engine.created.length, 1);
  assert.equal(f.engine.removed.length, 0);
  await assert.rejects(f.service.launchTerminals(f.session.id, { command: "must not start" }, controller.signal));
  assert.equal(f.engine.created.length, 1);
});

test("a blocked batch streams intent, deduplicates and cancels between items without blocking metadata", { timeout: 10000 }, async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const entered = deferred(), release = deferred();
  t.after(release.resolve);
  f.engine.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const request = { command: "worker", count: 3, idempotencyKey: "same-action" };
  const launch = await f.service.beginLaunch(f.session.id, request);
  await entered.promise;
  const duplicate = await f.service.beginLaunch(f.session.id, request);
  assert.equal(duplicate.id, launch.id);
  await assert.rejects(f.service.beginLaunch(f.session.id, { ...request, command: "different" }), /different options/);
  const start = performance.now();
  const snapshot = await f.service.renameSession(f.session.id, "Still responsive");
  assert.ok(performance.now() - start < 1000);
  assert.equal(snapshot.sessions[0].terminals[0].status, "starting");
  f.service.cancelLaunch(launch.id); release.resolve();
  const result = await f.service.launches.wait(launch.id);
  assert.equal(result.state, "cancelled");
  assert.equal(result.completed, 1);
  assert.equal(f.engine.created.length, 1);
  assert.equal(f.engine.removed.length, 0);
  const reopened = new SessionService(f.store, f.engine, f.files); await reopened.initialize();
  assert.equal((await reopened.beginLaunch(f.session.id, request)).id, launch.id);
  assert.equal(f.engine.created.length, 1);
});

test("shutdown waits for the started item and persists cancellation before closing writers", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  f.engine.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const record = await f.service.beginLaunch(f.session.id, { command: "worker", count: 3 });
  await entered.promise;
  let closed = false;
  const closing = f.service.close().then(() => { closed = true; });
  await setImmediate(); assert.equal(closed, false);
  release.resolve(); await closing;
  const recovered = await new Store(f.store.directory).load();
  assert.equal(recovered.launches.find(item => item.id === record.id)?.state, "cancelled");
  assert.equal(f.engine.created.length, 1);
  assert.equal(f.engine.removed.length, 0);
  const journal = new EventBus(f.store.directory); await journal.initialize();
  assert.ok(journal.replay(0).events.some(event => event.type === "launch-progress" && event.data.state === "cancelled"));
  await journal.close();
});

test("crash recovery never replays unfinished launches and retains an already created process", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const launched = await f.service.launchTerminals(f.session.id, { command: "worker" });
  await f.service.state.update(state => {
    state.launches[0].state = "running";
    state.sessions[0].terminals[0].launchState = "starting";
  });
  const reopened = new SessionService(f.store, f.engine, f.files); await reopened.initialize();
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.sessions[0].terminals[0].id, launched.terminalIds[0]);
  assert.equal(snapshot.sessions[0].terminals[0].status, "running");
  assert.equal(snapshot.launches![0].state, "cancelled");
  assert.equal(f.engine.created.length, 1);
});
