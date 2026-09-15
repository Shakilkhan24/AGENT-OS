/**
 * M4.6.a — context-source import tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { importContextSource, listContextImportsForRun, CONTEXT_IMPORT_META_PREFIX, importKey } from "../../src/runtime/db/context-import";
import { createTask, readTask } from "../../src/runtime/db/tasks";
import { createRun, readRun } from "../../src/runtime/db/runs";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const digestOf = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

test("importContextSource writes an audit row, idempotent on identical payload", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    const content = "AGENTS guidance here.";
    const digest = digestOf(content);
    const sourceId = randomUUID();
    const first = await importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: sourceId, kind: "context-source", origin: "filesystem:/repo/AGENTS.md", digest, bytes: content.length, content },
      importedBy: "user-1",
    });
    assert.ok(first.runId === runId);
    assert.match(first.payloadDigest, /^[0-9a-f]{64}$/);
    // Identical re-import (same sourceId, same content) ⇒ identical
    // audit digest (content-addressed; `importedAt` is intentionally
    // excluded from the digest input).
    const second = await importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: sourceId, kind: "context-source", origin: "filesystem:/repo/AGENTS.md", digest, bytes: content.length, content },
      importedBy: "user-1",
    });
    assert.equal(first.payloadDigest, second.payloadDigest);
    const rows = listContextImportsForRun(worker, runId);
    assert.equal(rows.length, 1);
  } finally { await worker.close(); }
});

test("importContextSource refuses digest mismatch when content is supplied (CONFLICT)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    const wrong = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    await assert.rejects(importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: randomUUID(), kind: "context-source", origin: "filesystem:/repo/AGENTS.md", digest: wrong, bytes: 0, content: "anything" },
      importedBy: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("importContextSource refuses bytes mismatch when content is supplied (INVALID_REQUEST)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    const content = "abc";
    const digest = digestOf(content);
    await assert.rejects(importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: randomUUID(), kind: "context-source", origin: "filesystem:/x", digest, bytes: content.length + 5, content },
      importedBy: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});

test("importContextSource refuses an unknown runId (NOT_FOUND)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await readTask(worker, randomUUID()) ? await createTask(worker, { title: "t", hostId: "h1" }) : { id: randomUUID() };
    void taskId;
    const missing = randomUUID();
    await assert.rejects(importContextSource(worker, {
      taskId: randomUUID(), runId: missing,
      source: { capabilityId: randomUUID(), kind: "context-source", origin: "x", digest: "f".repeat(64), bytes: 0 },
      importedBy: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("importContextSource refuses a non-context-source kind (INVALID_REQUEST)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    await assert.rejects(importContextSource(worker, {
      taskId, runId,
      // @ts-expect-error — intentionally wrong kind for the negative test
      source: { capabilityId: randomUUID(), kind: "skill", origin: "x", digest: "f".repeat(64), bytes: 0 },
      importedBy: "user-1",
    }), (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});

test("meta-key builder is correct", () => {
  const runId = randomUUID();
  const digest = "a".repeat(64);
  assert.equal(importKey(runId, digest), `${CONTEXT_IMPORT_META_PREFIX}${runId}:${digest}`);
});

test("importContextSource without content is accepted (digest is trusted as supplied)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    const digest = "b".repeat(64);
    const out = await importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: randomUUID(), kind: "context-source", origin: "preset-table:abc", digest, bytes: 0 },
      importedBy: "user-1",
    });
    assert.equal(out.digest, digest);
    assert.equal(out.bytes, 0);
    // Read the run back — no side effects beyond the meta row.
    const run = await readRun(worker, runId);
    assert.ok(run);
  } finally { await worker.close(); }
});
