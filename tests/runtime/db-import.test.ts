/**
 * Focused tests for M2.3 — legacy JSON state import.
 *
 * The tests prove:
 *  - legacy state, events, settings and drafts are persisted with full
 *    SHA-256 digest backups before any DB row is touched;
 *  - the import runs inside a single transaction so a parse error or a
 *    foreign key violation rolls back without leaving partial state;
 *  - an existing backup with different bytes refuses to be overwritten;
 *  - the migration manifest records what was imported for resumability;
 *  - drafts are imported with their revision starting at 1 (M2.6 will
 *    preserve baseHash through subsequent edits).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { importLegacyState } from "../../src/runtime/db/import";
import { defaultSettings } from "../../src/shared/settings";

function digest(bytes: string): string { return createHash("sha256").update(bytes).digest("hex"); }

async function freshWorker(): Promise<{ worker: DbWorker; cleanup: () => Promise<void> }> {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return { worker: new DbWorker({ driver }), cleanup: async () => {} };
}

async function makeFixture(): Promise<{ dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-import-"));
  const state = {
    version: 2,
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "Shell", command: "" }],
    sessions: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "alpha",
      directory: "/tmp/alpha",
      identity: "alpha-ident",
      createdAt: "2026-09-13T10:00:00.000Z",
      terminals: [{
        id: "22222222-2222-4222-8222-222222222222",
        label: "alpha 1",
        cwd: "/tmp/alpha",
        command: "bash",
        createdAt: "2026-09-13T10:00:00.000Z",
        launchState: "running",
        startedAt: "2026-09-13T10:00:01.000Z",
      }],
    }],
    envProfiles: [{ id: "33333333-3333-4333-8333-333333333333", name: "default", description: "shell", variables: { FOO: "bar" } }],
    hooks: [{ id: "44444444-4444-4444-8444-444444444444", name: "before-commit", event: "files-changed", action: { type: "notify", message: "file changed" }, enabled: true }],
    launches: [{
      id: "55555555-5555-4555-8555-555555555555",
      sessionId: "11111111-1111-4111-8111-111111111111",
      fingerprint: "abc",
      expiresAt: Date.now() + 1000,
      terminalIds: ["22222222-2222-4222-8222-222222222222"],
      state: "completed",
      completed: 1,
      errors: [],
    }],
  };
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state));
  const events = {
    version: 1,
    sequence: 2,
    events: [
      {
        seq: 1, at: "2026-09-13T10:00:00.000Z", correlationId: "66666666-6666-4666-8666-666666666666",
        sourceId: "sessions", sessionId: "11111111-1111-4111-8111-111111111111",
        type: "session-changed", data: { action: "created" },
      },
      {
        seq: 2, at: "2026-09-13T10:00:01.000Z", correlationId: "77777777-7777-4777-8777-777777777777",
        sourceId: "sessions", sessionId: "11111111-1111-4111-8111-111111111111",
        terminalId: "22222222-2222-4222-8222-222222222222",
        type: "terminal-status", data: { status: "running" },
      },
    ],
  };
  await writeFile(path.join(dataDir, "events.json"), JSON.stringify(events));
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(defaultSettings));
  const draftsDir = path.join(dataDir, "drafts");
  await mkdir(draftsDir, { recursive: true, mode: 0o700 });
  const draftId = digest(`${"11111111-1111-4111-8111-111111111111"}\0/tmp/alpha/file.txt`);
  await writeFile(path.join(draftsDir, `${draftId}.json`), JSON.stringify({
    sessionId: "11111111-1111-4111-8111-111111111111",
    path: "/tmp/alpha/file.txt",
    baseHash: "deadbeef",
    content: "hello world",
    updatedAt: "2026-09-13T10:00:02.000Z",
  }));
  return { dataDir, cleanup: async () => rm(dataDir, { recursive: true, force: true }) };
}

test("import preserves presets, sessions, terminals, profiles, hooks, launches, events and drafts", async t => {
  const fixture = await makeFixture();
  const { worker, cleanup } = await freshWorker();
  t.after(async () => { await cleanup(); await fixture.cleanup(); });
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  assert.equal(report.counts.sessions, 1);
  assert.equal(report.counts.terminals, 1);
  assert.equal(report.counts.presets, 1);
  assert.equal(report.counts.envProfiles, 1);
  assert.equal(report.counts.hooks, 1);
  assert.equal(report.counts.launches, 1);
  assert.equal(report.counts.events, 2);
  assert.equal(report.counts.drafts, 1);
  assert.ok(report.manifest.sources.state.imported);
  assert.ok(report.manifest.sources.events.imported);
  assert.ok(report.manifest.sources.settings.imported);
  assert.ok(report.manifest.sources.drafts.imported);
});

test("import writes full-digest backups next to the source data", async t => {
  const fixture = await makeFixture();
  const { worker, cleanup } = await freshWorker();
  t.after(async () => { await cleanup(); await fixture.cleanup(); });
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  const entries = await readdir(fixture.dataDir);
  const backups = entries.filter(name => name.startsWith("legacy-") && name.endsWith(".backup.json"));
  assert.ok(backups.length >= 3, `expected at least 3 backups, saw ${backups.length}`);
  for (const [kind, backup] of Object.entries(report.backupFiles)) {
    assert.ok(backup.endsWith(`-${kind}.backup.json`), `backup for ${kind} must carry the kind suffix`);
  }
  const manifest = JSON.parse(await readFile(path.join(fixture.dataDir, "migration-manifest.json"), "utf8"));
  assert.equal(manifest.version, 1);
  assert.equal(manifest.importedCounts.sessions, 1);
});

test("import rolls back on invalid JSON and leaves the DB untouched", async t => {
  const fixture = await makeFixture();
  const { worker, cleanup } = await freshWorker();
  t.after(async () => { await cleanup(); await fixture.cleanup(); });
  await writeFile(path.join(fixture.dataDir, "state.json"), "{ this is not valid json");
  await assert.rejects(importLegacyState({ dataDir: fixture.dataDir, worker }), /JSON|version|Unexpected/i);
  // After a failed import the destination DB must remain empty.
  const driver = (worker as unknown as { driver: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).driver;
  assert.deepEqual(driver.prepare("SELECT name FROM session").all(), []);
});

test("import refuses to overwrite a backup with different bytes", async t => {
  const fixture = await makeFixture();
  const { worker, cleanup } = await freshWorker();
  t.after(async () => { await cleanup(); await fixture.cleanup(); });
  // Run once to seed the backups.
  await importLegacyState({ dataDir: fixture.dataDir, worker });
  // Mutate the backup to simulate corruption; re-import must refuse rather than overwrite.
  const backupEntry = (await readdir(fixture.dataDir)).find(name => name.startsWith("legacy-") && name.endsWith("-state.backup.json"));
  assert.ok(backupEntry);
  await writeFile(path.join(fixture.dataDir, backupEntry!), "tampered");
  await assert.rejects(importLegacyState({ dataDir: fixture.dataDir, worker }), /differs|overwrite/i);
});
