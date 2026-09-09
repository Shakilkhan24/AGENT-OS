import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
test("v1 migrates once to v2, preserves original bytes, IDs and command intents", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-migrate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const initial = await store.load();
  const id = crypto.randomUUID();
  const original = JSON.stringify({
    version: 1,
    presets: initial.presets,
    sessions: [
      {
        id,
        name: "Project",
        directory: "/tmp/project",
        identity: "1:2",
        createdAt: "now",
        terminals: [
          {
            id: crypto.randomUUID(),
            label: "Saved",
            cwd: "/tmp/project",
            command: "do not replay",
            createdAt: "now",
          },
        ],
      },
    ],
  });
  await writeFile(path.join(root, "state.json"), original);
  const migrated = await store.load();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.sessions[0].id, id);
  assert.deepEqual(migrated.envProfiles, []);
  assert.deepEqual(migrated.hooks, []);
  const backup = (await readdir(root)).find((name) => name.includes("backup"))!;
  assert.equal(await readFile(path.join(root, backup), "utf8"), original);
  assert.deepEqual(await store.load(), migrated);
  assert.equal(
    (await readdir(root)).filter((name) => name.includes("backup")).length,
    1,
  );
  await writeFile(path.join(root, "state.json"), '{"version":99}');
  await assert.rejects(store.load(), /preserved/);
  assert.equal(
    await readFile(path.join(root, "state.json"), "utf8"),
    '{"version":99}',
  );
});
