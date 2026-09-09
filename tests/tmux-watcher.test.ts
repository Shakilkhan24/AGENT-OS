import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { TmuxWatcher } from "../src/main/tmux-watcher";

test("wait-for observers restart after signals and dispose without further notifications", async () => {
  const watcher = new TmuxWatcher(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10)"], process.env);
  let notifications = 0;
  const unsubscribe = watcher.subscribe(() => { notifications++; });
  for (let attempt = 0; notifications < 2 && attempt < 100; attempt++) await delay(20);
  unsubscribe();
  const before = notifications;
  await delay(50);
  assert.ok(before >= 2);
  assert.equal(notifications, before);
});
