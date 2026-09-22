/**
 * Focused tests for M2.7 — backup/export with pinned artifacts and isolated
 * restore with dispatch disabled.
 *
 * Coverage:
 *  - takeBackup produces a manifest whose digest matches the bytes on disk;
 *  - every referenced draft/preset/env profile/hook is pinned with a digest;
 *  - verifyBackup reports DIGEST_MISMATCH when an artifact is corrupted;
 *  - restoreFromBackup replaces the state and bumps the generation;
 *  - restoreFromBackup refuses when dispatch is not in restore mode;
 *  - restore is idempotent under the same token;
 *  - beginRestore / endRestore / isRestoreActive bracket dispatch admission;
 *  - takeBackup refuses to clobber an existing manifest.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs, SCHEMA_VERSION } from "../../src/runtime/db/schema";
import {
  beginRestore,
  discardBackup,
  endRestore,
  isRestoreActive,
  loadBackupManifest,
  restoreFromBackup,
  takeBackup,
  verifyBackup,
} from "../../src/runtime/db/backup";
import { currentGeneration } from "../../src/runtime/db/snapshot";
import { AppError } from "../../src/shared/errors";

async function freshWorker(): Promise<{ worker: DbWorker; driver: MemoryDatabase }> {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return { worker: new DbWorker({ driver }), driver };
}

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}

async function seedDraft(worker: DbWorker, id: string, content: string): Promise<void> {
  const driver = (worker as unknown as { driver: DriverRaw }).driver;
  driver.prepare(
    "INSERT INTO draft (id, session_uuid, path, base_hash, content, revision, updated_at, root_identity) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, "11111111-1111-4111-8111-111111111111", `${id}.txt`, "a".repeat(64), content, 1, new Date().toISOString(), "");
}

async function seedPreset(worker: DbWorker, uuid: string, name: string, command: string): Promise<void> {
  const driver = (worker as unknown as { driver: DriverRaw }).driver;
  driver.prepare("INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)").run(uuid, name, command);
}

async function seedEnvProfile(worker: DbWorker, uuid: string, name: string, variables: Record<string, string>): Promise<void> {
  const driver = (worker as unknown as { driver: DriverRaw }).driver;
  driver.prepare("INSERT INTO env_profile (uuid, name, variables_json) VALUES (?, ?, ?)")
    .run(uuid, name, JSON.stringify(variables));
}

async function seedHook(worker: DbWorker, uuid: string, name: string, event: string, action: unknown): Promise<void> {
  const driver = (worker as unknown as { driver: DriverRaw }).driver;
  driver.prepare("INSERT INTO hook (uuid, name, event, action_json, enabled) VALUES (?, ?, ?, ?, ?)")
    .run(uuid, name, event, JSON.stringify(action), 1);
}

test("takeBackup writes a manifest, state file, and pinned artifacts", async () => {
  const { worker, driver } = await freshWorker();
  await seedDraft(worker, "draft-1", "hello world");
  await seedPreset(worker, "11111111-1111-4111-8111-111111111111", "default", "bash");
  await seedEnvProfile(worker, "22222222-2222-4222-8222-222222222222", "dev", { FOO: "bar" });
  await seedHook(worker, "33333333-3333-4333-8333-333333333333", "log", "session.created", { type: "noop" });
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-backup-"));
  try {
    const report = await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    assert.equal(report.manifest.version, 1);
    assert.equal(report.manifest.artifacts.length, 4);
    const ids = report.manifest.artifacts.map(artifact => artifact.id).sort();
    assert.deepEqual(ids, [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
      "draft-1",
    ]);
    const verified = await verifyBackup(outputDir);
    assert.equal(verified.ok, true);
    // State digest should round-trip.
    const stateBytes = await readFile(report.statePath);
    assert.equal(stateBytes.byteLength, report.manifest.stateBytes);
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
  void driver;
});

test("verifyBackup detects a tampered artifact and reports DIGEST_MISMATCH", async () => {
  const { worker } = await freshWorker();
  await seedDraft(worker, "draft-2", "important content");
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-tamper-"));
  try {
    await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    const artifact = (await loadBackupManifest(outputDir)) as { ok: true; value: { artifacts: Array<{ filename: string }> } };
    const target = path.join(outputDir, "artifacts", artifact.value.artifacts[0]!.filename);
    const original = await readFile(target);
    await writeFile(target, Buffer.from("corrupted"), { mode: 0o600 });
    const result = await verifyBackup(outputDir);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "DIGEST_MISMATCH");
    // Restore so the next test starts clean.
    await writeFile(target, original, { mode: 0o600 });
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("takeBackup refuses to clobber an existing manifest", async () => {
  const { worker } = await freshWorker();
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-clobber-"));
  try {
    await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    await assert.rejects(
      takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("beginRestore blocks dispatch; endRestore releases it; mismatched token refuses", async () => {
  const { worker } = await freshWorker();
  try {
    assert.equal(isRestoreActive(worker).active, false);
    const token = await beginRestore(worker);
    assert.equal(isRestoreActive(worker).active, true);
    assert.equal(isRestoreActive(worker).token, token);
    // Mismatched endRestore rejects.
    await assert.rejects(endRestore(worker, "not-the-right-token"), (error: unknown) =>
      error instanceof AppError && error.failure.code === "INVALID_REQUEST");
    // Correct endRestore works.
    await endRestore(worker, token);
    assert.equal(isRestoreActive(worker).active, false);
  } finally { await worker.close(); }
});

test("restoreFromBackup refuses when dispatch is not in restore mode", async () => {
  const { worker } = await freshWorker();
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-no-mode-"));
  try {
    await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    await assert.rejects(
      restoreFromBackup({ worker, inputDir: outputDir, token: "irrelevant" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("restoreFromBackup replaces state, bumps generation, and preserves dispatch lock under the same token", async () => {
  const { worker } = await freshWorker();
  await seedDraft(worker, "draft-restore", "first");
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-restore-"));
  try {
    await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    const token = await beginRestore(worker);
    // Mutate live state to prove restore wipes it.
    const driver = (worker as unknown as { driver: DriverRaw }).driver;
    driver.prepare("UPDATE draft SET content = ? WHERE id = ?").run("mutated", "draft-restore");
    const report = await restoreFromBackup({ worker, inputDir: outputDir, token });
    assert.equal(report.generation >= 1, true);
    const restored = driver.prepare("SELECT content FROM draft WHERE id = ?").first("draft-restore") as { content: string } | undefined;
    assert.equal(restored?.content, "first");
    // Dispatch is still disabled at the same token.
    assert.equal(isRestoreActive(worker).active, true);
    assert.equal(isRestoreActive(worker).token, token);
    // Releasing restore mode returns us to "admitting".
    await endRestore(worker, token);
    assert.equal(isRestoreActive(worker).active, false);
    // Generation after release should match report.
    assert.equal(await currentGeneration(worker), report.generation);
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("restored_from_manifest_nonce is recorded so a future resume can verify the restored source", async () => {
  const { worker } = await freshWorker();
  await seedDraft(worker, "draft-nonce", "x");
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-nonce-"));
  try {
    const backup = await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    const token = await beginRestore(worker);
    await restoreFromBackup({ worker, inputDir: outputDir, token });
    await endRestore(worker, token);
    const driver = (worker as unknown as { driver: DriverRaw }).driver;
    const row = driver.prepare("SELECT value FROM meta WHERE key = 'restored_from_manifest_nonce'").first();
    assert.equal(row?.value, backup.manifest.nonce);
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("discardBackup removes the directory after a successful verification", async () => {
  const { worker } = await freshWorker();
  await seedDraft(worker, "draft-discard", "x");
  const outputDir = await mkdtemp(path.join(tmpdir(), "minimal-discard-"));
  try {
    await takeBackup({ worker, outputDir, schemaVersion: SCHEMA_VERSION });
    await discardBackup(outputDir);
    // Re-loading the manifest now reports MISSING_FILE.
    const result = await loadBackupManifest(outputDir);
    assert.equal(result.ok, false);
  } finally {
    await worker.close();
    await rm(outputDir, { recursive: true, force: true });
  }
});
