import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorkspaceState } from "../src/main/workspace-state";
import { Store } from "../src/main/store";

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
