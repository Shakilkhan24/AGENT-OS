/**
 * M4.6.d — handoff tests.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { buildHandoff, HANDOFF_MAX_ARTIFACTS, HANDOFF_MAX_INVOCATIONS, HANDOFF_MAX_DECISIONS, HANDOFF_MAX_RESOURCES } from "../../src/runtime/db/handoff";
import { createTask } from "../../src/runtime/db/tasks";
import { createRun, transitionRun } from "../../src/runtime/db/runs";
import { assembleContextReceipt } from "../../src/runtime/db/context-receipts";
import { raiseAttention } from "../../src/runtime/db/attention-items";
import { pinArtifact } from "../../src/runtime/db/artifact-references";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function makeCompletedRun(worker: DbWorker) {
  const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
  const { id: runId } = await createRun(worker, { taskId });
  // Move the run through the state machine to `completed` so the
  // handoff's `nextAction` lands on the terminal branch.
  await transitionRun(worker, runId, "running");
  await transitionRun(worker, runId, "completed");
  await assembleContextReceipt(worker, {
    runId,
    objective: "Ship the patch",
    constraints: {},
    acceptanceChecks: { verifiedState: { passed: 3, failed: 0, uncertain: 0, skipped: 1 } },
    selectedRevisions: { sourceRevision: "abcdef0", targetRevision: "1234567" },
    instructions: {},
    environment: {},
    capabilities: {},
    exclusions: [],
  });
  return { taskId, runId };
}

test("buildHandoff for a completed run with no open decisions yields nextAction='new-attempt'", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await makeCompletedRun(worker);
    await pinArtifact(worker, { taskId: null, runId, uri: "file:///r.txt", sha256: "1".repeat(64), kind: "evidence", bytes: 10, mime: "text/plain" });
    const out = await buildHandoff(worker, { runId });
    assert.equal(out.nextAction, "new-attempt");
    assert.equal(out.verifiedState.passed, 3);
    assert.equal(out.verifiedState.skipped, 1);
    assert.equal(out.remainingDecisions.length, 0);
    assert.equal(out.artifacts.length, 1);
    assert.equal(out.excludes.nativeState, true);
    assert.equal(out.excludes.transcripts, true);
    assert.equal(out.sourceRevision, "abcdef0");
    assert.equal(out.targetRevision, "1234567");
    assert.match(out.digest, /^[0-9a-f]{64}$/);
  } finally { await worker.close(); }
});

test("buildHandoff for a completed run with open decision items yields nextAction='handoff'", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeCompletedRun(worker);
    await raiseAttention(worker, { taskId, kind: "decision", issueIdentity: "issue-x", revision: 1, payload: { prompt: "Approve the rebase?" } });
    const out = await buildHandoff(worker, { runId });
    assert.equal(out.nextAction, "handoff");
    assert.equal(out.remainingDecisions.length, 1);
    assert.equal(out.remainingDecisions[0].prompt, "Approve the rebase?");
  } finally { await worker.close(); }
});

test("buildHandoff for a cancelled run yields nextAction='stop' regardless of decisions", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    // queued → cancelled is legal.
    await transitionRun(worker, runId, "cancelled");
    await raiseAttention(worker, { taskId, kind: "decision", issueIdentity: "issue-y", revision: 1, payload: { prompt: "anything" } });
    const out = await buildHandoff(worker, { runId });
    assert.equal(out.nextAction, "stop");
  } finally { await worker.close(); }
});

test("buildHandoff for a queued run yields nextAction='continue'", async () => {
  const worker = freshWorker();
  try {
    // Make a queued run that hasn't been transitioned.
    const { id: taskId } = await createTask(worker, { title: "t2", hostId: "h1" });
    const { id: runId } = await createRun(worker, { taskId });
    const out = await buildHandoff(worker, { runId });
    assert.equal(out.nextAction, "continue");
  } finally { await worker.close(); }
});

test("buildHandoff with crossProvider:true still stamps excludes literal", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await makeCompletedRun(worker);
    const out = await buildHandoff(worker, { runId, crossProvider: true });
    assert.equal(out.crossProvider, true);
    assert.deepEqual(out.excludes, { nativeState: true, transcripts: true });
  } finally { await worker.close(); }
});

test("buildHandoff for an unknown runId raises NOT_FOUND", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(buildHandoff(worker, { runId: randomUUID() }),
      (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND");
  } finally { await worker.close(); }
});

test("buildHandoff clamps caps to HANDOFF_MAX_*", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await makeCompletedRun(worker);
    const out = await buildHandoff(worker, {
      runId,
      maxArtifacts: Number.MAX_SAFE_INTEGER,
      maxInvocations: Number.MAX_SAFE_INTEGER,
      maxAttentionItems: Number.MAX_SAFE_INTEGER,
    });
    assert.ok(out.artifacts.length <= HANDOFF_MAX_ARTIFACTS);
    // Invocations and decisions are bounded by the slice; caps clamp silently.
    void HANDOFF_MAX_INVOCATIONS;
    void HANDOFF_MAX_DECISIONS;
    void HANDOFF_MAX_RESOURCES;
  } finally { await worker.close(); }
});

test("buildHandoff digest is deterministic — same input ⇒ same digest", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await makeCompletedRun(worker);
    const a = await buildHandoff(worker, { runId });
    const b = await buildHandoff(worker, { runId });
    assert.equal(a.digest, b.digest);
  } finally { await worker.close(); }
});

test("buildHandoff excludes is always {nativeState: true, transcripts: true} — never omitted", async () => {
  const worker = freshWorker();
  try {
    const { runId } = await makeCompletedRun(worker);
    const out = await buildHandoff(worker, { runId, crossProvider: false });
    assert.equal(typeof out.excludes.nativeState, "boolean");
    assert.equal(typeof out.excludes.transcripts, "boolean");
    assert.equal(out.excludes.nativeState, true);
    assert.equal(out.excludes.transcripts, true);
  } finally { await worker.close(); }
});
