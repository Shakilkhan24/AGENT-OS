import test from "node:test";
import assert from "node:assert/strict";
import { deferred, serviceFixture } from "./support";
import { SessionService } from "../src/main/service";

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
