import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DraftStore } from "../src/main/draft-store";

test("drafts survive restart, replace one file's draft and refuse to evict unsaved work", async (t) => {
  const profile = await mkdtemp(path.join(tmpdir(), "minimal-drafts-"));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const store = new DraftStore(profile, 1);
  const input = { sessionId: crypto.randomUUID(), path: "draft.txt", baseHash: "a".repeat(64), content: "unsaved" };
  const first = await store.save(input);
  await store.save({ ...input, content: "latest" });
  await assert.rejects(store.save({ ...input, path: "second" }), /full/);
  const reopened = new DraftStore(profile);
  assert.equal((await reopened.list()).length, 1);
  assert.equal((await reopened.read(first.id)).content, "latest");
  assert.equal((await stat(path.join(store.directory, `${first.id}.json`))).mode & 0o077, 0);
  await reopened.remove(first.id);
  assert.deepEqual(await reopened.list(), []);
});
