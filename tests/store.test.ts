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
  await store.close();
});

test("recovery preserves malformed bytes through edits and restart", async (t) => {
  for (const original of [Buffer.from([123, 0xff, 0xfe])]) {
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


test("newer schemas refuse writes even after a caught load error or a restart", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-future-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new Store(root);
  const valid = await store.load();
  const original = '{"version":99,"sessions":["precious"],"newField":true}';
  await writeFile(path.join(root, "state.json"), original);
  for (const candidate of [store, new Store(root)]) {
    await assert.rejects(candidate.load(), error => error instanceof Error &&
      "failure" in error && (error.failure as { code: string }).code === "VERSION_MISMATCH");
    assert.equal(candidate.recoveredFromInvalid, undefined);
    await assert.rejects(candidate.save(valid), /not writable/);
    await candidate.close();
    assert.equal(await readFile(path.join(root, "state.json"), "utf8"), original);
    assert.deepEqual(await readdir(root), ["state.json"]);
  }
});

test("unloaded and unreadable stores cannot save an empty replacement", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-unreadable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const valid = await new Store(root).load();
  const store = new Store(root);
  await assert.rejects(store.save(valid), /not writable/);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(root, "state.json"));
  await assert.rejects(store.load());
  await assert.rejects(store.save(valid), /not writable/);
  await store.close();
});
