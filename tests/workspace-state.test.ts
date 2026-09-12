import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceState } from "../src/main/workspace-state";
import { Store } from "../src/main/store";
import { deferred } from "./support";

test("state commits do not lose concurrent edits or expose uncommitted data", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = new WorkspaceState(new Store(root));
  await repository.initialize();
  await Promise.all(Array.from({ length: 8 }, (_, index) => repository.update(state => {
    state.presets.push({ id: crypto.randomUUID(), name: `Preset ${index}`, command: "" });
  })));
  assert.equal(repository.read().presets.length, 9);
  repository.read().presets.length = 0;
  await assert.rejects(repository.update(state => { state.presets.length = 0; throw new Error("abort"); }));
  assert.equal(repository.read().presets.length, 9);
});

test("pending, invalid and failed saves never become visible or leak into later commits", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-commit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const state = new WorkspaceState(store);
  await state.initialize();
  const save = store.save.bind(store);
  const started = deferred(), release = deferred();
  store.save = async () => { started.resolve(); await release.promise; throw new Error("disk full"); };
  const update = assert.rejects(state.update(s => { s.presets[0].name = "Rejected"; }), /disk full/);
  await started.promise;
  assert.equal(state.view().presets[0].name, "Shell");
  release.resolve(); await update;
  assert.equal(state.read().presets[0].name, "Shell");
  store.save = save;
  await assert.rejects(state.update(s => { s.presets[0].name = ""; }));
  await state.update(s => { s.presets[0].command = "echo ok"; });
  assert.equal((await new Store(root).load()).presets[0].name, "Shell");
  await store.close();
});
