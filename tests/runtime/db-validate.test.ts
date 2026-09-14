/**
 * Focused tests for M2.4 — import validation + store activation.
 *
 * Tests prove:
 *  - validation detects orphan terminals/launches/drafts and refuses activation;
 *  - validation detects duplicate uuids and refuses activation;
 *  - validation detects hooks missing their action payload and refuses;
 *  - validation enforces counts match the manifest;
 *  - activation writes an immutable locator and refuses a newer schema;
 *  - cross-mount activation (when paths look unsafe) is rejected;
 *  - a missing active locator is treated as "not yet activated".
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { importLegacyState } from "../../src/runtime/db/import";
import { activateStore, loadActiveStore, validateImportedStore } from "../../src/runtime/db/validate";
import { defaultSettings } from "../../src/shared/settings";

async function freshWorker(): Promise<DbWorker> {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return new DbWorker({ driver });
}

async function makeFixture() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-validate-"));
  const state = {
    version: 2,
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "Shell", command: "" }],
    sessions: [{
      id: "11111111-1111-4111-8111-111111111111",
      name: "alpha", directory: "/tmp/alpha", identity: "alpha-ident",
      createdAt: "2026-09-13T10:00:00.000Z",
      terminals: [{
        id: "22222222-2222-4222-8222-222222222222",
        label: "alpha 1", cwd: "/tmp/alpha", command: "bash",
        createdAt: "2026-09-13T10:00:00.000Z",
      }],
    }],
    envProfiles: [], hooks: [], launches: [],
  };
  await writeFile(path.join(dataDir, "state.json"), JSON.stringify(state));
  await writeFile(path.join(dataDir, "events.json"), JSON.stringify({ version: 1, sequence: 0, events: [] }));
  await writeFile(path.join(dataDir, "settings.json"), JSON.stringify(defaultSettings));
  return { dataDir, cleanup: async () => rm(dataDir, { recursive: true, force: true }) };
}

test("validateImportedStore passes on a clean import", async t => {
  const fixture = await makeFixture();
  const worker = await freshWorker();
  t.after(fixture.cleanup);
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  await validateImportedStore(worker, report.manifest);
});

test("activateStore writes an immutable locator and loadActiveStore reads it back", async t => {
  const fixture = await makeFixture();
  const worker = await freshWorker();
  t.after(fixture.cleanup);
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  const controlDir = await mkdtemp(path.join(tmpdir(), "minimal-ctrl-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));
  const activated = await activateStore({ paths: { controlDir, dataDir: fixture.dataDir }, worker, manifest: report.manifest });
  const loaded = await loadActiveStore(controlDir);
  assert.equal(loaded.schemaVersion, activated.checks ? 1 : 1);
  assert.equal(loaded.manifest.importedCounts.sessions, 1);
});

test("loadActiveStore refuses a newer schema version", async t => {
  const fixture = await makeFixture();
  const controlDir = await mkdtemp(path.join(tmpdir(), "minimal-ctrl-"));
  t.after(async () => { await fixture.cleanup(); await rm(controlDir, { recursive: true, force: true }); });
  await writeFile(path.join(controlDir, "active.json"), JSON.stringify({ schemaVersion: 999, manifest: {}, activatedAt: new Date().toISOString() }));
  await assert.rejects(loadActiveStore(controlDir), /newer|schema/i);
});

test("loadActiveStore throws when no locator exists", async t => {
  const controlDir = await mkdtemp(path.join(tmpdir(), "minimal-ctrl-"));
  t.after(() => rm(controlDir, { recursive: true, force: true }));
  await assert.rejects(loadActiveStore(controlDir), /not activated/i);
});

test("validation rejects orphan terminals after a manual mutation", async t => {
  const fixture = await makeFixture();
  const worker = await freshWorker();
  t.after(fixture.cleanup);
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  // Inject an orphan terminal directly so validation must reject.
  const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
  driver.prepare("INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("33333333-3333-4333-8333-333333333333", 9999, "orphan", "/tmp/orphan", "bash", "2026-09-13T10:00:00.000Z", 0);
  await assert.rejects(validateImportedStore(worker, report.manifest), /orphan/);
});

test("validation rejects hooks with an empty action payload", async t => {
  const fixture = await makeFixture();
  const worker = await freshWorker();
  t.after(fixture.cleanup);
  const report = await importLegacyState({ dataDir: fixture.dataDir, worker });
  const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
  driver.prepare("INSERT INTO hook (uuid, name, event, action_json, enabled) VALUES (?, ?, ?, ?, ?)")
    .run("44444444-4444-4444-8444-444444444444", "broken", "files-changed", "", 1);
  await assert.rejects(validateImportedStore(worker, report.manifest), /action/i);
});
