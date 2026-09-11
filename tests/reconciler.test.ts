import test from "node:test";
import assert from "node:assert/strict";
import { serviceFixture } from "./support";

test("engine failures are visible once and recovery persists exit details without relaunching", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const launch = await f.service.launchTerminals(f.session.id, { command: "worker" });
  f.engine.inspectFailure = new Error("Offline");
  const unavailable = await f.service.snapshot();
  await f.service.snapshot();
  assert.equal(unavailable.engineFailure?.sourceId, "engine");
  assert.equal(f.service.events.replay(0).events.filter(e => e.type === "operation-failed").length, 1);
  f.engine.inspectFailure = undefined;
  const pane = f.engine.processes.get(launch.terminalIds[0])!;
  pane.dead = true; pane.exitCode = 19; pane.endedAt = new Date().toISOString();
  const snapshot = await f.service.snapshot();
  assert.equal(snapshot.sessions[0].terminals[0].exitCode, 19);
  await f.service.state.store.flush();
  assert.equal((await f.store.load()).sessions[0].terminals[0].endedAt, pane.endedAt);
  assert.equal(f.service.events.replay(0).events.filter(e => e.type === "engine-restored").length, 1);
});
