import test from "node:test";
import assert from "node:assert/strict";
import { DraftMirror } from "../src/renderer/draft-mirror";
import { deferred } from "./support";

test("discard follows an in-flight mirror so late writes cannot resurrect a draft", async () => {
  const release = deferred(), entered = deferred();
  const actions: string[] = [];
  const mirror = new DraftMirror(async input => {
    entered.resolve(); await release.promise; actions.push("write");
    return { ...input, id: "a".repeat(64), updatedAt: new Date().toISOString() };
  }, async () => { actions.push("remove"); }, () => {});
  mirror.schedule({ sessionId: crypto.randomUUID(), path: "file", baseHash: "b".repeat(64), content: "draft" });
  const flushing = mirror.flush(); await entered.promise;
  const discarding = mirror.discard(); release.resolve();
  await flushing; await discarding;
  assert.deepEqual(actions, ["write", "remove"]);
});
