/**
 * M4.6.c — bounded memory view tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  viewSessionMemory,
  viewTaskMemory,
  viewTerminalMemory,
  appendTerminalHistory,
  MEMORY_VIEW_MAX_RUNS_PER_TASK,
  MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN,
  MEMORY_VIEW_MAX_ATTENTION_ITEMS,
  MEMORY_VIEW_MAX_ARTIFACTS_PER_RUN,
  MEMORY_VIEW_MAX_TERMINAL_LINES,
  MEMORY_VIEW_MAX_TASKS_PER_SESSION,
  TERMINAL_HISTORY_META_PREFIX,
  historyKey,
} from "../../src/runtime/db/memory-views";
import { createTask } from "../../src/runtime/db/tasks";
import { createRun, transitionRun } from "../../src/runtime/db/runs";
import { createInvocation } from "../../src/runtime/db/invocations";
import { pinArtifact } from "../../src/runtime/db/artifact-references";
import { raiseAttention } from "../../src/runtime/db/attention-items";
import { importContextSource } from "../../src/runtime/db/context-import";
import { recordRevisionUpdate } from "../../src/runtime/db/revision-update";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

// --- TerminalHistory meta-key + writer seam tests ----------------------

test("historyKey builds the expected meta key", () => {
  const id = randomUUID();
  assert.equal(historyKey(id, 1), `${TERMINAL_HISTORY_META_PREFIX}${id}:1`);
});

test("appendTerminalHistory writes a line with content-addressed digest; seq is monotonic", async () => {
  const worker = freshWorker();
  try {
    // Create a session + terminal so the FK check is satisfied.
    const termUuid = randomUUID();
    const driver = (worker as unknown as { driver: { prepare(s: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare(`INSERT INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000001", "First", "/tmp/proj", "ident", new Date().toISOString(), 0, "{}");
    driver.prepare(`INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(termUuid, 1, "shell", "/tmp/proj", "bash", new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null, null, null);
    const line1 = await appendTerminalHistory(worker, { terminalUuid: termUuid, stream: "stdout", content: "hello" });
    assert.equal(line1.seq, 1);
    assert.match(line1.payloadDigest, /^[0-9a-f]{64}$/);
    const line2 = await appendTerminalHistory(worker, { terminalUuid: termUuid, stream: "stderr", content: "warn" });
    assert.equal(line2.seq, 2);
  } finally { await worker.close(); }
});

// --- TerminalMemoryView -------------------------------------------------

test("viewTerminalMemory returns terminal + bounded lines", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    const driver = (worker as unknown as { driver: { prepare(s: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare(`INSERT INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000002", "S", "/tmp", "i", new Date().toISOString(), 0, "{}");
    driver.prepare(`INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(termUuid, 1, "shell", "/tmp", "bash", new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null, null, null);
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: 10 });
    assert.equal(out.kind, "terminal");
    assert.equal(out.data.terminalUuid, termUuid);
    assert.equal(out.cap.maxLines, 10);
    assert.match(out.digest, /^[0-9a-f]{64}$/);
  } finally { await worker.close(); }
});

test("viewTerminalMemory rejects unknown terminal (NOT_FOUND)", () => {
  const worker = freshWorker();
  try {
    assert.throws(
      () => viewTerminalMemory(worker, { terminalUuid: randomUUID() }),
      (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND",
    );
  } finally { worker.close(); }
});

test("viewTerminalMemory clamps maxLines to the cap; rejects 0/negative", () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    const driver = (worker as unknown as { driver: { prepare(s: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare(`INSERT INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000003", "S", "/tmp", "i", new Date().toISOString(), 0, "{}");
    driver.prepare(`INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(termUuid, 1, "shell", "/tmp", "bash", new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null, null, null);
    const huge = viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: Number.MAX_SAFE_INTEGER });
    assert.equal(huge.cap.maxLines, MEMORY_VIEW_MAX_TERMINAL_LINES);
    assert.throws(
      () => viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: 0 }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
    );
    assert.throws(
      () => viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: -1 }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
    );
  } finally { worker.close(); }
});

// --- TaskMemoryView -----------------------------------------------------

test("viewTaskMemory returns bounded slice for a task with runs/imports/updates", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1", projectId: "proj-1" });
    const { id: runId } = await createRun(worker, { taskId });
    await createInvocation(worker, {
      runId, idempotencyKey: "k1", canonicalDigest: "a".repeat(64),
      providerVersion: "v1", model: "m1", accountMode: "anonymous",
    });
    const content = "AGENTS";
    const digest = createHash("sha256").update(content, "utf8").digest("hex");
    await importContextSource(worker, {
      taskId, runId,
      source: { capabilityId: randomUUID(), kind: "context-source", origin: "filesystem:/repo/AGENTS.md", digest, bytes: content.length, content },
      importedBy: "user-1",
    });
    await recordRevisionUpdate(worker, {
      runId, baseRevision: "0000000", headRevision: "1111111",
      sourceDigest: "c".repeat(64), rationale: "initial", actor: "user-1",
    });
    await pinArtifact(worker, {
      taskId, runId, uri: "file:///x.txt", sha256: "9".repeat(64),
      kind: "context", bytes: 12, mime: "text/plain",
    });
    await raiseAttention(worker, { taskId, kind: "decision", issueIdentity: "issue-1", revision: 1, payload: { prompt: "ok?" } });
    const out = await viewTaskMemory(worker, { taskId, maxRuns: 5, maxInvocationsPerRun: 5, maxAttentionItems: 5, maxArtifacts: 5 });
    assert.equal(out.kind, "task");
    assert.equal(out.data.runs.length, 1);
    const run = out.data.runs[0];
    assert.equal(run.runId, runId);
    assert.equal(run.invocations.length, 1);
    assert.equal(run.imports.length, 1);
    assert.equal(run.revisionUpdates.length, 1);
    assert.equal(run.artifacts.length, 1);
    assert.equal(out.data.attention.length, 1);
    assert.match(out.digest, /^[0-9a-f]{64}$/);
  } finally { await worker.close(); }
});

test("viewTaskMemory for a task with no runs returns empty runs[]", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const out = await viewTaskMemory(worker, { taskId });
    assert.equal(out.data.runs.length, 0);
    assert.equal(out.data.attention.length, 0);
  } finally { await worker.close(); }
});

test("viewTaskMemory rejects unknown taskId (NOT_FOUND)", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(viewTaskMemory(worker, { taskId: randomUUID() }),
      (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("viewTaskMemory clamps maxRuns to MEMORY_VIEW_MAX_RUNS_PER_TASK", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const out = await viewTaskMemory(worker, { taskId, maxRuns: Number.MAX_SAFE_INTEGER });
    assert.equal(out.cap.maxRuns, MEMORY_VIEW_MAX_RUNS_PER_TASK);
    assert.equal(out.cap.maxInvocationsPerRun, MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN);
    assert.equal(out.cap.maxAttentionItems, MEMORY_VIEW_MAX_ATTENTION_ITEMS);
    assert.equal(out.cap.maxArtifacts, MEMORY_VIEW_MAX_ARTIFACTS_PER_RUN);
  } finally { await worker.close(); }
});

// --- SessionMemoryView --------------------------------------------------

test("viewSessionMemory groups tasks by projectId === sessionId", async () => {
  const worker = freshWorker();
  try {
    await createTask(worker, { title: "a", hostId: "h1", projectId: "proj-x" });
    await createTask(worker, { title: "b", hostId: "h1", projectId: "proj-x" });
    await createTask(worker, { title: "c", hostId: "h1", projectId: "proj-y" });
    const out = await viewSessionMemory(worker, { sessionId: "proj-x" });
    assert.equal(out.kind, "session");
    assert.equal(out.data.sessionId, "proj-x");
    assert.equal(out.data.taskCount, 2);
    assert.equal(out.data.tasks.length, 2);
    assert.equal(out.cap.maxTasks, MEMORY_VIEW_MAX_TASKS_PER_SESSION);
  } finally { await worker.close(); }
});

test("viewSessionMemory clamps all caps", async () => {
  const worker = freshWorker();
  try {
    const out = await viewSessionMemory(worker, {
      sessionId: "none",
      maxTasks: Number.MAX_SAFE_INTEGER,
      maxRunsPerTask: Number.MAX_SAFE_INTEGER,
      maxInvocationsPerRun: Number.MAX_SAFE_INTEGER,
      maxAttentionItems: Number.MAX_SAFE_INTEGER,
    });
    assert.equal(out.cap.maxTasks, MEMORY_VIEW_MAX_TASKS_PER_SESSION);
    assert.equal(out.cap.maxRunsPerTask, MEMORY_VIEW_MAX_RUNS_PER_TASK);
    assert.equal(out.cap.maxInvocationsPerRun, MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN);
    assert.equal(out.cap.maxAttentionItems, MEMORY_VIEW_MAX_ATTENTION_ITEMS);
  } finally { await worker.close(); }
});

// --- Determinism + negative caps ---------------------------------------

test("memory-view digest is deterministic — same input ⇒ same digest", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const a = await viewTaskMemory(worker, { taskId });
    const b = await viewTaskMemory(worker, { taskId });
    assert.equal(a.digest, b.digest);
  } finally { await worker.close(); }
});

test("memory-view rejects 0 or negative caps with INVALID_REQUEST", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    await assert.rejects(viewTaskMemory(worker, { taskId, maxRuns: 0 }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
    await assert.rejects(viewTaskMemory(worker, { taskId, maxRuns: -3 }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
    await assert.rejects(viewSessionMemory(worker, { sessionId: "x", maxTasks: 0 }),
      (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST");
  } finally { await worker.close(); }
});

// --- Terminal-view digest changes when underlying state changes --------

test("terminal-memory-view digest changes when a new history line is appended", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    const driver = (worker as unknown as { driver: { prepare(s: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare(`INSERT INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("00000000-0000-4000-8000-000000000004", "S", "/tmp", "i", new Date().toISOString(), 0, "{}");
    driver.prepare(`INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(termUuid, 1, "shell", "/tmp", "bash", new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null, null, null);
    const a = viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: 10 });
    await appendTerminalHistory(worker, { terminalUuid: termUuid, stream: "stdout", content: "hello" });
    const b = viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: 10 });
    assert.notEqual(a.digest, b.digest);
    assert.equal(b.data.lines.length, 1);
  } finally { await worker.close(); }
});

// --- Avoid unused-import warning: transitionRun is referenced in some
// downstream consumers. Import it via a single character reference.
void transitionRun;
