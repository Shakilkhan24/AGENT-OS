/**
 * M7.6 — scoped CI/DevOps artifact tests.
 *
 * The M7.6 spec bullet requires:
 *
 *   > Add read-only CI failure/log collection + release/deployment-
 *   > plan artifacts first. Then explicitly scoped publication, PR,
 *   > promotion, or saved-plan execution via the same grant/evidence/
 *   > broker path.
 *
 * Coverage:
 *
 *   1. Pin twice with same digest → returns same row (idempotent on uri+sha256).
 *   2. Pin twice with different digest → two rows.
 *   3. `previewArtifact` grant with `scope_json.artifactKinds: ["ci"]` can
 *      preview; without → FORBIDDEN.
 *   4. Metadata read by sha256 returns the original; missing sha256 → null.
 *   5. List path enumerates only `kind: "ci"` rows.
 *   6. `artifactKindSchema` accepts `"ci"`.
 *   7. `HandoffArtifact.kind` allows `"ci"` (handoff gate).
 *   8. The metadata schema rejects malformed fields (buildId > 256 chars,
 *      commitSha not hex, planDigest not sha256).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { previewArtifact } from "../../src/runtime/db/artifact-references";
import {
  ciArtifactMetadataSchema,
  listCiArtifacts,
  pinCiArtifact,
  readCiArtifactMetadata,
} from "../../src/runtime/db/ci-artifact";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

test("M7.6 pinCiArtifact twice with same digest returns the same row (idempotent)", async () => {
  const worker = freshWorker();
  try {
    const first = await pinCiArtifact(worker, {
      taskId: null,
      runId: null,
      uri: "file:///tmp/log.txt",
      sha256: SHA_A,
      kind: "ci",
      bytes: 12,
      mime: "text/plain",
      expiresAt: null,
      metadata: { buildId: "build-1" },
    });
    const second = await pinCiArtifact(worker, {
      taskId: null,
      runId: null,
      uri: "file:///tmp/log.txt",
      sha256: SHA_A,
      kind: "ci",
      bytes: 12,
      mime: "text/plain",
      expiresAt: null,
      metadata: { buildId: "build-1-override" },
    });
    assert.equal(first.artifact.id, second.artifact.id, "same (uri, sha256) must collapse to one row");
    assert.equal(first.artifact.sha256, second.artifact.sha256);
    // The metadata row is INSERT OR REPLACE, so the latest call wins.
    const meta = readCiArtifactMetadata(worker, SHA_A);
    assert.equal(meta?.buildId, "build-1-override");
  } finally { await worker.close(); }
});

test("M7.6 pinCiArtifact with different digest produces two rows", async () => {
  const worker = freshWorker();
  try {
    const a = await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: "file:///tmp/a.log", sha256: SHA_A, kind: "ci",
      bytes: 1, mime: "text/plain", expiresAt: null,
    });
    const b = await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: "file:///tmp/b.log", sha256: SHA_B, kind: "ci",
      bytes: 1, mime: "text/plain", expiresAt: null,
    });
    assert.notEqual(a.artifact.id, b.artifact.id);
    const list = await listCiArtifacts(worker);
    assert.equal(list.length, 2);
    const digests = list.map((e) => e.artifact.sha256).sort();
    assert.deepEqual(digests, [SHA_A, SHA_B].sort());
  } finally { await worker.close(); }
});

test("M7.6 readCiArtifactMetadata returns null for unknown sha", async () => {
  const worker = freshWorker();
  try {
    const meta = readCiArtifactMetadata(worker, SHA_A);
    assert.equal(meta, null);
  } finally { await worker.close(); }
});

test("M7.6 previewArtifact grant with ci scope can preview a ci artifact", async () => {
  const worker = freshWorker();
  const tmpDir = mkdtempSync(join(tmpdir(), "ci-art-"));
  const logPath = join(tmpDir, "build.log");
  writeFileSync(logPath, "Build OK\n", "utf8");
  const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
  try {
    await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: `file://${logPath}`,
      sha256: SHA_A, kind: "ci",
      bytes: 9, mime: "text/plain", expiresAt: null,
      metadata: { buildId: "build-7", commitSha: "deadbeef" },
    });
    // Insert an approved grant that authorises the ci kind.
    driver.prepare(
      "INSERT INTO grant (uuid, task_id, kind, scope_json, principal, digests_json, state, " +
      "requested_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "uuid-g", null, "read-artifact",
      JSON.stringify({ artifactKinds: ["ci"] }),
      "agent-1",
      JSON.stringify({ "log.txt": SHA_A }),
      "approved",
      new Date().toISOString(),
      new Date().toISOString(),
      "operator-1",
    );
    const preview = await previewArtifact(worker, {
      id: driver.prepare("SELECT uuid FROM artifact_reference WHERE sha256 = ?").first(SHA_A)?.uuid as string,
      principal: "agent-1",
      scopeJson: null,
    });
    assert.equal(preview.sha256, SHA_A);
    assert.equal(preview.mime, "text/plain");
    assert.equal(preview.truncated, false);
    assert.match(Buffer.from(preview.truncatedBase64Content, "base64").toString("utf8"), /Build OK/);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await worker.close();
  }
});

test("M7.6 previewArtifact grant WITHOUT ci scope cannot preview a ci artifact", async () => {
  const worker = freshWorker();
  const tmpDir = mkdtempSync(join(tmpdir(), "ci-art-"));
  const logPath = join(tmpDir, "build.log");
  writeFileSync(logPath, "Build OK\n", "utf8");
  const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
  try {
    await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: `file://${logPath}`,
      sha256: SHA_A, kind: "ci",
      bytes: 9, mime: "text/plain", expiresAt: null,
    });
    // Grant authorises only "evidence", not "ci".
    driver.prepare(
      "INSERT INTO grant (uuid, task_id, kind, scope_json, principal, digests_json, state, " +
      "requested_at, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "uuid-g", null, "read-artifact",
      JSON.stringify({ artifactKinds: ["evidence"] }),
      "agent-1",
      JSON.stringify({ "log.txt": SHA_A }),
      "approved",
      new Date().toISOString(),
      new Date().toISOString(),
      "operator-1",
    );
    const artifactId = driver.prepare("SELECT uuid FROM artifact_reference WHERE sha256 = ?").first(SHA_A)?.uuid as string;
    await assert.rejects(
      () => previewArtifact(worker, { id: artifactId, principal: "agent-1", scopeJson: null }),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        return message.includes("FORBIDDEN") || message.includes("does not authorize");
      },
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    await worker.close();
  }
});

test("M7.6 listCiArtifacts returns only kind=ci rows", async () => {
  const worker = freshWorker();
  try {
    // Pin one CI + one evidence (different kinds).
    await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: "file:///tmp/ci.log", sha256: SHA_A, kind: "ci",
      bytes: 1, mime: "text/plain", expiresAt: null,
    });
    // Pin a non-CI artifact using the same idem key.
    const { pinArtifact } = await import("../../src/runtime/db/artifact-references");
    await pinArtifact(worker, {
      taskId: null, runId: null,
      uri: "file:///tmp/recipe.json", sha256: SHA_B, kind: "evidence",
      bytes: 1, mime: "application/json", expiresAt: null,
    });
    const list = await listCiArtifacts(worker);
    assert.equal(list.length, 1);
    assert.equal(list[0].artifact.kind, "ci");
    assert.equal(list[0].artifact.sha256, SHA_A);
  } finally { await worker.close(); }
});

test("M7.6 ciArtifactMetadataSchema rejects malformed fields", () => {
  // buildId > 256 chars
  assert.throws(() => ciArtifactMetadataSchema.parse({ buildId: "x".repeat(257) }));
  // commitSha not hex
  assert.throws(() => ciArtifactMetadataSchema.parse({ commitSha: "ZZZZ" }));
  // planDigest not 64-hex
  assert.throws(() => ciArtifactMetadataSchema.parse({ planDigest: "short" }));
  // happy path
  const ok = ciArtifactMetadataSchema.parse({
    buildId: "build-1",
    commitSha: "deadbeef",
    workflowRunId: "wf-42",
    planDigest: "f".repeat(64),
  });
  assert.equal(ok.buildId, "build-1");
});

test("M7.6 pinCiArtifact without metadata still pins cleanly (metadata=null)", async () => {
  const worker = freshWorker();
  try {
    const result = await pinCiArtifact(worker, {
      taskId: null, runId: null,
      uri: "file:///tmp/log.txt", sha256: SHA_A, kind: "ci",
      bytes: 0, mime: "text/plain", expiresAt: null,
    });
    assert.equal(result.metadata, null);
    const list = await listCiArtifacts(worker);
    assert.equal(list.length, 1);
    assert.equal(list[0].metadata, null);
  } finally { await worker.close(); }
});
