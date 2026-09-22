/**
 * M3c.3 — `previewArtifact` tests.
 *
 * Coverage:
 *  1. Preview of an approved-grant-pinned artifact returns a base64
 *     prefix and `truncated: false`.
 *  2. Preview of an artifact whose declared `bytes` exceed the cap
 *     returns `{truncated: true, truncatedBase64Content: ""}` without
 *     reading.
 *  3. Preview with no matching approved grant throws `FORBIDDEN`.
 *  4. Preview with a grant whose `scope.artifactKinds` excludes the
 *     artifact's `kind` throws `FORBIDDEN`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { pinArtifact, previewArtifact, MAX_PREVIEW_BYTES } from "../../src/runtime/db/artifact-references";
import { requestGrant, decideGrant } from "../../src/runtime/db/grants";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface TempFile {
  uri: string;
  cleanup: () => void;
}

function makeTempFile(name: string, content: Buffer): TempFile {
  const dir = join(tmpdir(), `minimal-preview-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, content);
  return {
    uri: `file://${path}`,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

test("previewArtifact: returns base64 prefix for an approved-grant-pinned file", async () => {
  const worker = freshWorker();
  try {
    const body = Buffer.from("hello world\n");
    const file = makeTempFile("hello.txt", body);
    const digest = sha256Of(body);
    const artifact = await pinArtifact(worker, {
      uri: file.uri,
      sha256: digest,
      kind: "context",
      bytes: body.byteLength,
      mime: "text/plain",
    });
    const grant = await requestGrant(worker, {
      taskId: null,
      kind: "capability",
      principal: "user",
      scope: { artifactKinds: ["context"] },
      digests: { sha256: digest },
    });
    await decideGrant(worker, grant.id, { decision: "approve", decidedBy: "operator" });

    const preview = await previewArtifact(worker, {
      id: artifact.id,
      principal: "user",
    });
    assert.equal(preview.id, artifact.id);
    assert.equal(preview.sha256, digest);
    assert.equal(preview.mime, "text/plain");
    assert.equal(preview.bytes, body.byteLength);
    assert.equal(preview.truncated, false);
    assert.ok(preview.truncatedBase64Content.length > 0);
    const decoded = Buffer.from(preview.truncatedBase64Content, "base64").toString("utf8");
    assert.equal(decoded, body.toString("utf8"));
  } finally { await worker.close(); }
});

test("previewArtifact: returns truncated=true and empty content when bytes exceed cap", async () => {
  const worker = freshWorker();
  try {
    // Declare bytes > MAX_PREVIEW_BYTES — no file is even read.
    const declaredBytes = MAX_PREVIEW_BYTES + 1;
    const digest = sha256Of(Buffer.from("declared-only"));
    const artifact = await pinArtifact(worker, {
      uri: "file:///nonexistent/path",
      sha256: digest,
      kind: "context",
      bytes: declaredBytes,
      mime: "application/octet-stream",
    });
    const grant = await requestGrant(worker, {
      taskId: null,
      kind: "capability",
      principal: "user",
      scope: { artifactKinds: ["context"] },
      digests: { sha256: digest },
    });
    await decideGrant(worker, grant.id, { decision: "approve", decidedBy: "operator" });

    const preview = await previewArtifact(worker, {
      id: artifact.id,
      principal: "user",
    });
    assert.equal(preview.bytes, declaredBytes);
    assert.equal(preview.truncated, true);
    assert.equal(preview.truncatedBase64Content, "");
  } finally { await worker.close(); }
});

test("previewArtifact: throws FORBIDDEN when no approved grant matches the digest + principal", async () => {
  const worker = freshWorker();
  try {
    const body = Buffer.from("restricted\n");
    const file = makeTempFile("restricted.txt", body);
    const digest = sha256Of(body);
    const artifact = await pinArtifact(worker, {
      uri: file.uri,
      sha256: digest,
      kind: "context",
      bytes: body.byteLength,
      mime: "text/plain",
    });
    // No grant raised — preview must refuse.
    await assert.rejects(
      previewArtifact(worker, { id: artifact.id, principal: "user" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("previewArtifact: throws FORBIDDEN when grant scope excludes the artifact kind", async () => {
  const worker = freshWorker();
  try {
    const body = Buffer.from("output-block\n");
    const file = makeTempFile("out.bin", body);
    const digest = sha256Of(body);
    // Artifact is `output` kind but the grant only authorises `context`.
    const artifact = await pinArtifact(worker, {
      uri: file.uri,
      sha256: digest,
      kind: "output",
      bytes: body.byteLength,
      mime: "application/octet-stream",
    });
    const grant = await requestGrant(worker, {
      taskId: null,
      kind: "capability",
      principal: "user",
      scope: { artifactKinds: ["context"] },
      digests: { sha256: digest },
    });
    await decideGrant(worker, grant.id, { decision: "approve", decidedBy: "operator" });

    await assert.rejects(
      previewArtifact(worker, { id: artifact.id, principal: "user" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});
