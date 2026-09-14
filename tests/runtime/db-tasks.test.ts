/**
 * M3a Increment 1 — Task / Run / Invocation / DispatchIntent / Workspace /
 * ArtifactReference / AttentionItem entity tests.
 *
 * Coverage:
 *  - Task creation captures identity fields; transitions are enforced.
 *  - Run can exist without a terminal; run/task_id FK enforced.
 *  - Invocation idempotency: same key + same digest returns the same row;
 *    same key + different digest raises CONFLICT.
 *  - DispatchIntent state machine: recorded → claimed → spawned → acked
 *    is legal; reverse raises CONFLICT.
 *  - Workspace lease id is settable + clears.
 *  - ArtifactReference (uri, sha256) is unique; expires_at drives the
 *    `isArtifactExpired` helper.
 *  - AttentionItem (issueIdentity, revision) is unique; transition chain
 *    enforced.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask, transitionTask, listTasks, readTask, setTaskIdentity } from "../../src/runtime/db/tasks";
import { createRun, transitionRun, listRunsForTask, attachTerminal } from "../../src/runtime/db/runs";
import { createInvocation, transitionInvocation, listInvocationsForRun } from "../../src/runtime/db/invocations";
import { recordDispatchIntent, transitionDispatchIntent, listDispatchIntentsForRun } from "../../src/runtime/db/dispatch-intents";
import { createWorkspace, setHeadRevision, setWorkspaceLease, listWorkspacesForTask } from "../../src/runtime/db/workspaces";
import { pinArtifact, findArtifactByUri, isArtifactExpired } from "../../src/runtime/db/artifact-references";
import { raiseAttention, transitionAttention, listAttention } from "../../src/runtime/db/attention-items";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

test("createTask captures identity fields and persists them", async () => {
  const worker = freshWorker();
  try {
    const { task } = await createTask(worker, {
      title: "Fix the failing test",
      objective: "Make the snapshot suite green",
      projectId: "minimal",
      hostId: "devbox-01",
      baseIdentity: "abcdef0123456789",
      rootIdentity: "2080:12345",
      providerVersion: "claude-1.0",
      model: "claude-opus",
      accountMode: "authenticated",
    });
    assert.equal(task.title, "Fix the failing test");
    assert.equal(task.providerVersion, "claude-1.0");
    assert.equal(task.model, "claude-opus");
    assert.equal(task.accountMode, "authenticated");
    assert.equal(task.hostId, "devbox-01");
    assert.equal(task.baseIdentity, "abcdef0123456789");
    assert.equal(task.rootIdentity, "2080:12345");
    assert.equal(task.status, "draft");
  } finally { await worker.close(); }
});

test("transitionTask enforces the legal transition set", async () => {
  const worker = freshWorker();
  try {
    const { id } = await createTask(worker, { title: "x", hostId: "h1" });
    await transitionTask(worker, id, { to: "ready" });
    await transitionTask(worker, id, { to: "active" });
    await transitionTask(worker, id, { to: "done" });
    // done → ready is illegal.
    await assert.rejects(transitionTask(worker, id, { to: "ready" }), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("setTaskIdentity refuses on a terminal task", async () => {
  const worker = freshWorker();
  try {
    const { id } = await createTask(worker, { title: "x", hostId: "h1" });
    await transitionTask(worker, id, { to: "abandoned" });
    await assert.rejects(setTaskIdentity(worker, id, { model: "x" }), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("listTasks filters by status and projectId", async () => {
  const worker = freshWorker();
  try {
    await createTask(worker, { title: "a", hostId: "h1", projectId: "p1" });
    await createTask(worker, { title: "b", hostId: "h1", projectId: "p2" });
    const list = await listTasks(worker, { projectId: "p1" });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.title, "a");
  } finally { await worker.close(); }
});

test("createRun exists without a terminal; terminalUuid is nullable", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    assert.equal(run.taskId, taskId);
    assert.equal(run.terminalUuid, null);
    assert.equal(run.status, "queued");
    const list = await listRunsForTask(worker, taskId);
    assert.equal(list.length, 1);
  } finally { await worker.close(); }
});

test("createRun refuses a non-existent taskId", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(createRun(worker, { taskId: "11111111-1111-4111-8111-111111111111" }), (error: unknown) =>
      error instanceof AppError && error.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("transitionRun sets startedAt and endedAt at the right edges", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    const started = await transitionRun(worker, run.id, "running");
    assert.ok(started.startedAt !== null);
    assert.equal(started.endedAt, null);
    const ended = await transitionRun(worker, run.id, "completed");
    assert.ok(ended.endedAt !== null);
  } finally { await worker.close(); }
});

test("attachTerminal records the terminalUuid", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    const updated = await attachTerminal(worker, run.id, "22222222-2222-4222-8222-222222222222");
    assert.equal(updated.terminalUuid, "22222222-2222-4222-8222-222222222222");
  } finally { await worker.close(); }
});

test("createInvocation idempotency returns the existing row", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    const digest = "a".repeat(64);
    const first = await createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: digest,
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    const second = await createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: digest,
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    assert.equal(first.id, second.id);
  } finally { await worker.close(); }
});

test("createInvocation rejects the same key with a different digest", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    await createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: "a".repeat(64),
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    await assert.rejects(createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: "b".repeat(64),
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    }), (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("transitionInvocation enforces the state machine", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    const inv = await createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: "a".repeat(64),
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    await transitionInvocation(worker, inv.id, { to: "admitted" });
    await transitionInvocation(worker, inv.id, { to: "spawned" });
    await transitionInvocation(worker, inv.id, { to: "observing" });
    await transitionInvocation(worker, inv.id, { to: "done" });
    await assert.rejects(transitionInvocation(worker, inv.id, { to: "admitted" }), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
    const list = await listInvocationsForRun(worker, run.id);
    assert.equal(list.length, 1);
  } finally { await worker.close(); }
});

test("recordDispatchIntent + transition walk the recorded → acked chain", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const run = await createRun(worker, { taskId });
    const intent = await recordDispatchIntent(worker, {
      runId: run.id, method: "snapshot", deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(intent.state, "recorded");
    await transitionDispatchIntent(worker, intent.id, "claimed");
    await transitionDispatchIntent(worker, intent.id, "spawned");
    const acked = await transitionDispatchIntent(worker, intent.id, "acked");
    assert.equal(acked.state, "acked");
    await assert.rejects(transitionDispatchIntent(worker, intent.id, "claimed"), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
    const list = await listDispatchIntentsForRun(worker, run.id);
    assert.equal(list.length, 1);
  } finally { await worker.close(); }
});

test("createWorkspace + setHeadRevision + setWorkspaceLease roundtrip", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const ws = await createWorkspace(worker, {
      taskId, kind: "git-worktree", location: "/tmp/wt1",
      baseIdentity: "abcdef0", worktreePath: "/tmp/wt1", headRevision: "abcdef0",
    });
    assert.equal(ws.kind, "git-worktree");
    const updated = await setHeadRevision(worker, ws.id, "deadbeef");
    assert.equal(updated.headRevision, "deadbeef");
    const leased = await setWorkspaceLease(worker, ws.id, "33333333-3333-4333-8333-333333333333");
    assert.equal(leased.leaseId, "33333333-3333-4333-8333-333333333333");
    const cleared = await setWorkspaceLease(worker, ws.id, null);
    assert.equal(cleared.leaseId, null);
    const list = await listWorkspacesForTask(worker, taskId);
    assert.equal(list.length, 1);
  } finally { await worker.close(); }
});

test("pinArtifact dedupes by (uri, sha256) and reads back the same row", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
    const uri = "file:///tmp/example.txt";
    const sha = "a".repeat(64);
    const first = await pinArtifact(worker, { taskId, uri, sha256: sha, kind: "context", bytes: 12, mime: "text/plain" });
    const second = await pinArtifact(worker, { taskId, uri, sha256: sha, kind: "context", bytes: 12, mime: "text/plain" });
    assert.equal(first.id, second.id);
    const found = await findArtifactByUri(worker, uri, sha);
    assert.equal(found?.id, first.id);
  } finally { await worker.close(); }
});

test("isArtifactExpired respects expiresAt; null means never", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const past = { expiresAt: "2026-09-14T11:00:00.000Z" } as Parameters<typeof isArtifactExpired>[0];
  const future = { expiresAt: "2026-09-14T13:00:00.000Z" } as Parameters<typeof isArtifactExpired>[0];
  const never = { expiresAt: null } as Parameters<typeof isArtifactExpired>[0];
  assert.equal(isArtifactExpired(past, now), true);
  assert.equal(isArtifactExpired(future, now), false);
  assert.equal(isArtifactExpired(never, now), false);
});

test("raiseAttention enforces unique (issueIdentity, revision) and the state machine", async () => {
  const worker = freshWorker();
  try {
    const first = await raiseAttention(worker, { kind: "decision", issueIdentity: "issue-1", revision: 1 });
    await assert.rejects(raiseAttention(worker, { kind: "decision", issueIdentity: "issue-1", revision: 1 }), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
    await transitionAttention(worker, first.id, "seen");
    await transitionAttention(worker, first.id, "dismissed");
    await transitionAttention(worker, first.id, "resolved");
    await assert.rejects(transitionAttention(worker, first.id, "seen"), (error: unknown) =>
      error instanceof AppError && error.failure.code === "CONFLICT");
    const list = await listAttention(worker);
    assert.equal(list.length, 1);
  } finally { await worker.close(); }
});

test("readTask returns undefined for a missing id", async () => {
  const worker = freshWorker();
  try {
    const read = await readTask(worker, "11111111-1111-4111-8111-111111111111");
    assert.equal(read, undefined);
  } finally { await worker.close(); }
});
