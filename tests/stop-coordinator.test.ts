import test from "node:test";
import assert from "node:assert/strict";
import { deferred, serviceFixture } from "./support";

test("deletion waits for a started engine operation, then removes only its own terminal", { timeout: 10000 }, async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const neighbour = await f.service.launchTerminals(f.session.id, { command: "neighbour" });
  const entered = deferred(), release = deferred(); t.after(release.resolve);
  f.engine.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const launch = await f.service.beginLaunch(f.session.id, { command: "worker" });
  await entered.promise;
  const deleting = f.service.deleteTerminal(f.session.id, launch.terminalIds[0]);
  release.resolve();
  await deleting; await f.service.launches.wait(launch.id);
  assert.deepEqual([...f.engine.processes.keys()], neighbour.terminalIds);
  assert.deepEqual(f.engine.removed, launch.terminalIds);
});
