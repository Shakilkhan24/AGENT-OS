import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { createHash } from "node:crypto";
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
  // A v99 state.json is no longer fatal: the file is preserved on disk and
  // the in-memory state falls back to the empty default. `recoveredFromInvalid`
  // exposes the reason so the caller can surface a toast.
  const recovered = await store.load();
  assert.equal(recovered.version, 2);
  assert.equal(recovered.sessions.length, 0);
  assert.match(
    store.recoveredFromInvalid ?? "",
    /Saved state could not be read; original file preserved\./,
  );
  assert.equal(
    await readFile(path.join(root, "state.json"), "utf8"),
    '{"version":99}',
  );
});

test("recovery preserves malformed and future-schema bytes through edits and restart", async (t) => {
  for (const original of [Buffer.from([123, 0xff, 0xfe]), Buffer.from('{"version":99,"sessions":["precious"]}')]) {
    const root = await mkdtemp(path.join(tmpdir(), "minimal-recovery-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "state.json"), original);
    const store = new Store(root);
    const recovered = await store.load();
    assert.match(store.recoveredFromInvalid!, /Recovery copy:/);
    recovered.presets[0].name = "New work";
    await store.save(recovered); await store.close();
    const backups = (await readdir(root)).filter(name => name.includes("recovery"));
    assert.equal(backups.length, 1);
    assert.deepEqual(await readFile(path.join(root, backups[0])), original);
    assert.equal((await new Store(root).load()).presets[0].name, "New work");
  }
});

test("a conflicting recovery backup prevents writable fallback", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-backup-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const original = "{broken";
  await writeFile(path.join(root, "state.json"), original);
  const digest = createHash("sha256").update(original).digest("hex");
  await writeFile(path.join(root, `state.recovery-${digest}.backup.json`), "partial backup");
  await assert.rejects(new Store(root).load(), /backup contents differ/);
  assert.equal(await readFile(path.join(root, "state.json"), "utf8"), original);
});
