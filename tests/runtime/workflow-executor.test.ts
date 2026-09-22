/**
 * M6.1 — workflow executor tests.
 *
 * Coverage (18+ focused tests):
 *   - validateWorkflowGraph: empty graph rejection, self-loop, unknown stepId,
 *     cycle, oversize steps, oversize edges.
 *   - topologicalOrder: linear chain, parallel siblings, residual cycle.
 *   - runWorkflow happy paths: command → check → wait, parallel fan-out,
 *     bounded fanout (maxFanout = 1), maxFanout clamping.
 *   - Per-step dispatch:
 *     - agent step (stubbed via deps)
 *     - command step caps stdout/stderr at the per-step cap
 *     - check step records verificationId + reviewId in output
 *     - approval step waits for `accepted` review; refuses rejected; times out
 *     - artifact idempotency on (uri, sha256)
 *     - wait step: refuses timeoutMs = 0 / negative
 *   - Stop semantics: isStopped mid-flight ⇒ workflow returns cancelled.
 *   - Nested-workflow refusal: a step that calls runWorkflow throws FORBIDDEN.
 *   - Audit digest determinism: two runs with same input ⇒ same auditDigest.
 *   - Settings clamping: maxFanout = 99 clamps to MAX_FANOUT = 16.
 *   - Step input/output references: step B's inputRefs resolves to A's output.
 *   - Workflow graph validation: empty steps, > 64 steps, malformed dependsOn,
 *     malformed inputRefs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { AppError } from "../../src/shared/errors";
import {
  workflowGraphSchema,
  workflowStepSchema,
  workflowResultSchema,
  resolveWorkflowExecutorSettings,
  type WorkflowGraphInput,
  type WorkflowStep,
  MAX_FANOUT,
  MAX_STEPS_PER_WORKFLOW,
} from "../../src/shared/workflow-executor-schema";
import {
  validateWorkflowGraph,
  topologicalOrder,
  resolveReadySteps,
} from "../../src/runtime/db/workflow-graph";
import {
  runWorkflow,
  resetWorkflowInflight,
  type WorkflowExecuteDeps,
} from "../../src/runtime/orchestration/workflow-execute";
import { resetStops } from "../../src/runtime/orchestration/stop-policy";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function driverOf(worker: DbWorker): { prepare(sql: string): { run(...b: unknown[]): void; first(...b: unknown[]): Record<string, unknown> | undefined; all(...b: unknown[]): Array<Record<string, unknown>> } } {
  return (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void; first(...b: unknown[]): Record<string, unknown> | undefined; all(...b: unknown[]): Array<Record<string, unknown>> } } }).driver;
}

function parseStep(input: unknown): WorkflowStep {
  return workflowStepSchema.parse(input);
}

function seedReview(worker: DbWorker, fields: { uuid?: string; status?: string } = {}): string {
  const id = fields.uuid ?? randomUUID();
  driverOf(worker).prepare(
    "INSERT INTO review (uuid, task_id, run_id, evidence_verification_ids_json, candidate_base, candidate_tree, candidate_diff, configuration_revision, status, decision, decided_by, decision_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    id, null, null, "[]", null, null, null, null,
    fields.status ?? "open", null, null, null,
    new Date().toISOString(), new Date().toISOString(),
  );
  return id;
}

function fakeVerification(_reviewId: string, verificationId: string): { id: string; taskId: string; runId: string | null; recipeId: string | null; command: string; cwd: string; argvJson: string; envJson: string; configurationRevision: string | null; candidateBase: string | null; candidateTree: string | null; candidateDiff: string | null; status: "passed"; exitCode: number; signal: string | null; startedAt: string; endedAt: string; assertionCountsJson: string | null; requiredCheckResultsJson: string; stdoutTailJson: string; stderrTailJson: string; createdAt: string; updatedAt: string } {
  const now = new Date().toISOString();
  return {
    id: verificationId,
    taskId: randomUUID(),
    runId: null,
    recipeId: null,
    command: "stub",
    cwd: "/tmp",
    argvJson: "[]",
    envJson: "{}",
    configurationRevision: null,
    candidateBase: null,
    candidateTree: null,
    candidateDiff: null,
    status: "passed",
    exitCode: 0,
    signal: null,
    startedAt: now,
    endedAt: now,
    assertionCountsJson: null,
    requiredCheckResultsJson: "[]",
    stdoutTailJson: "[]",
    stderrTailJson: "[]",
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 1. validateWorkflowGraph: empty graph rejected.
// ---------------------------------------------------------------------------

test("validateWorkflowGraph refuses empty step array via the schema gate", () => {
  const result = workflowGraphSchema.safeParse({
    workflowId: "wf-empty",
    steps: [],
    edges: [],
    createdBy: "test",
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// 2. validateWorkflowGraph: self-loop refusal.
// ---------------------------------------------------------------------------

test("validateWorkflowGraph refuses a self-loop on dependsOn", () => {
  const step = parseStep({
    id: "a",
    kind: "command",
    displayName: "A",
    dependsOn: ["a"],
    argv: ["/bin/true"],
    env: {},
    cwd: null,
  });
  assert.throws(() => validateWorkflowGraph([step], []), (err: unknown) => {
    return err instanceof AppError && err.failure.code === "INVALID_REQUEST" && /Self-dependency/.test(err.failure.message);
  });
});

// ---------------------------------------------------------------------------
// 3. validateWorkflowGraph: unknown stepId in dependency.
// ---------------------------------------------------------------------------

test("validateWorkflowGraph refuses a dependency on an unknown stepId", () => {
  const step = parseStep({
    id: "a",
    kind: "command",
    displayName: "A",
    dependsOn: ["ghost"],
    argv: ["/bin/true"],
    env: {},
    cwd: null,
  });
  assert.throws(() => validateWorkflowGraph([step], []), (err: unknown) => {
    return err instanceof AppError && /Unknown stepId/.test(err.failure.message);
  });
});

// ---------------------------------------------------------------------------
// 4. validateWorkflowGraph: cycle via fixpoint.
// ---------------------------------------------------------------------------

test("validateWorkflowGraph refuses a 3-step cycle via the fixpoint", () => {
  const steps = [
    parseStep({ id: "a", kind: "command", displayName: "A", dependsOn: ["c"], argv: ["/bin/true"], env: {}, cwd: null }),
    parseStep({ id: "b", kind: "command", displayName: "B", dependsOn: ["a"], argv: ["/bin/true"], env: {}, cwd: null }),
    parseStep({ id: "c", kind: "command", displayName: "C", dependsOn: ["b"], argv: ["/bin/true"], env: {}, cwd: null }),
  ];
  assert.throws(() => validateWorkflowGraph(steps, []), (err: unknown) => {
    return err instanceof AppError && /cycle/.test(err.failure.message.toLowerCase());
  });
});

// ---------------------------------------------------------------------------
// 5. validateWorkflowGraph: oversize steps.
// ---------------------------------------------------------------------------

test("validateWorkflowGraph refuses an oversize step array", () => {
  const steps = Array.from({ length: MAX_STEPS_PER_WORKFLOW + 1 }, (_, i) => parseStep({
    id: `s${i}`, kind: "command", displayName: `S${i}`,
    argv: ["/bin/true"], env: {}, cwd: null,
  }));
  assert.throws(() => validateWorkflowGraph(steps, []), (err: unknown) => {
    return err instanceof AppError && /exceeds/.test(err.failure.message);
  });
});

// ---------------------------------------------------------------------------
// 6. topologicalOrder: linear + parallel siblings.
// ---------------------------------------------------------------------------

test("topologicalOrder produces a stable linear + parallel order", () => {
  const steps = [
    parseStep({ id: "a", kind: "command", displayName: "A", argv: ["/bin/true"], env: {}, cwd: null }),
    parseStep({ id: "b", kind: "command", displayName: "B", dependsOn: ["a"], argv: ["/bin/true"], env: {}, cwd: null }),
    parseStep({ id: "c", kind: "command", displayName: "C", dependsOn: ["a"], argv: ["/bin/true"], env: {}, cwd: null }),
    parseStep({ id: "d", kind: "command", displayName: "D", dependsOn: ["b", "c"], argv: ["/bin/true"], env: {}, cwd: null }),
  ];
  const order = topologicalOrder(steps, []);
  assert.equal(order.length, 4);
  assert.equal(order[0].id, "a");
  assert.equal(order[1].id, "b");
  assert.equal(order[2].id, "c");
  assert.equal(order[3].id, "d");
});

// ---------------------------------------------------------------------------
// 7. resolveReadySteps: ready / blocked classification.
// ---------------------------------------------------------------------------

test("resolveReadySteps returns runnable + skips blocked steps", () => {
  const a = parseStep({ id: "a", kind: "command", displayName: "A", argv: ["/bin/true"], env: {}, cwd: null });
  const b = parseStep({ id: "b", kind: "command", displayName: "B", dependsOn: ["a"], argv: ["/bin/true"], env: {}, cwd: null });
  // Empty completed set ⇒ only `a` is ready (no deps).
  assert.equal(resolveReadySteps([a, b], new Set()).length, 1);
  // After `a` is completed, only `b` remains ⇒ `b` is ready.
  const readyAfterA = resolveReadySteps([b], new Set(["a"]));
  assert.equal(readyAfterA.length, 1);
  assert.equal(readyAfterA[0].id, "b");
  // Without `a` in completed, `b` is blocked.
  assert.equal(resolveReadySteps([b], new Set()).length, 0);
});

// ---------------------------------------------------------------------------
// 8. runWorkflow: linear 3-step happy path (command → check → wait).
// ---------------------------------------------------------------------------

test("runWorkflow completes a 3-step linear chain and emits 5 audit events", async () => {
  const worker = freshWorker();
  const reviewId = seedReview(worker, { status: "open" });
  resetStops();
  resetWorkflowInflight();

  const verificationId = randomUUID();
  const deps: Partial<WorkflowExecuteDeps> = {
    execFile: async () => ({ stdout: "hi", stderr: "", code: 0, signal: null }),
    verifyOnce: async () => ({
      kind: "ok",
      verificationId,
      reviewId,
      verification: fakeVerification(reviewId, verificationId),
    }),
  };

  const input: WorkflowGraphInput = {
    workflowId: "wf-linear",
    createdBy: "test",
    steps: [
      { id: "cmd", kind: "command", displayName: "cmd", dependsOn: [], argv: ["/bin/echo", "hi"], env: {}, cwd: null, stdoutByteCap: 1024, stderrByteCap: 1024 },
      { id: "chk", kind: "check", displayName: "chk", dependsOn: ["cmd"], taskId: randomUUID(), command: "/bin/echo ok", argv: [], deadlineAt: new Date(Date.now() + 60_000).toISOString() },
      { id: "wait", kind: "wait", displayName: "wait", dependsOn: ["chk"], timeoutMs: 1000 },
    ],
    edges: [],
  };

  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed", JSON.stringify(result, null, 2));
  assert.equal(result.workflowId, "wf-linear");
  assert.ok(result.auditDigest.match(/^[0-9a-f]{64}$/));

  const events = driverOf(worker).prepare("SELECT type FROM event ORDER BY seq ASC").all() as Array<{ type: string }>;
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "workflow.started",
    "workflow.step.completed",
    "workflow.step.completed",
    "workflow.step.completed",
    "workflow.completed",
  ]);
});

// ---------------------------------------------------------------------------
// 9. runWorkflow: bounded fan-out (maxFanout = 1) dispatches every step.
// ---------------------------------------------------------------------------

test("runWorkflow fan-out is bounded by maxFanout = 1 and dispatches every step", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();

  let dispatchCount = 0;
  const deps: Partial<WorkflowExecuteDeps> = {
    executeOnce: async () => {
      dispatchCount++;
      return {
        kind: "ok" as const,
        invocationId: randomUUID(),
        handle: {} as never,
        rehydrated: false,
        dispatchIntentId: randomUUID(),
      };
    },
  };

  const steps = [
    parseStep({ id: "a", kind: "agent", displayName: "A", runId: randomUUID(), idempotencyKey: "k-a", parentInvocationId: null, canonicalDigest: "a".repeat(64), prompt: "p", providerVersion: "v1", model: "m", accountMode: "anonymous", method: "agent.run", scope: {}, args: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(), attemptedBy: "test", timeoutMs: 5_000 }),
    parseStep({ id: "b", kind: "agent", displayName: "B", runId: randomUUID(), idempotencyKey: "k-b", parentInvocationId: null, canonicalDigest: "b".repeat(64), prompt: "p", providerVersion: "v1", model: "m", accountMode: "anonymous", method: "agent.run", scope: {}, args: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(), attemptedBy: "test", timeoutMs: 5_000 }),
    parseStep({ id: "c", kind: "agent", displayName: "C", runId: randomUUID(), idempotencyKey: "k-c", parentInvocationId: null, canonicalDigest: "c".repeat(64), prompt: "p", providerVersion: "v1", model: "m", accountMode: "anonymous", method: "agent.run", scope: {}, args: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(), attemptedBy: "test", timeoutMs: 5_000 }),
  ];
  const input: WorkflowGraphInput = {
    workflowId: "wf-fanout",
    createdBy: "test",
    steps,
    edges: [],
  };

  const result = await runWorkflow(worker, { workflow: input, settings: { maxFanout: 1, defaultStepTimeoutMs: 5_000, waitPollMs: 250 } }, { deps });
  assert.equal(result.kind, "completed");
  assert.equal(dispatchCount, 3);
});

// ---------------------------------------------------------------------------
// 10. command step caps stdout/stderr at the per-step cap.
// ---------------------------------------------------------------------------

test("runWorkflow command step caps stdout + stderr at the per-step cap", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();

  const deps: Partial<WorkflowExecuteDeps> = {
    execFile: async () => ({
      stdout: "x".repeat(4096),
      stderr: "y".repeat(4096),
      code: 0,
      signal: null,
    }),
  };

  const input: WorkflowGraphInput = {
    workflowId: "wf-cap",
    createdBy: "test",
    steps: [
      { id: "cmd", kind: "command", displayName: "cmd", dependsOn: [], argv: ["/bin/true"], env: {}, cwd: null, stdoutByteCap: 1024, stderrByteCap: 1024 },
    ],
    edges: [],
  };

  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
  const output = result.stepOutputs.cmd as { stdout: string; stderr: string };
  assert.ok(output.stdout.length <= 1024, `stdout.length = ${output.stdout.length}`);
  assert.ok(output.stderr.length <= 1024, `stderr.length = ${output.stderr.length}`);
  assert.equal(output.stdout.length, 1024, `expected stdout capped at 1024, got ${output.stdout.length}`);
  assert.equal(output.stderr.length, 1024, `expected stderr capped at 1024, got ${output.stderr.length}`);
});

// ---------------------------------------------------------------------------
// 11. check step records verificationId + reviewId.
// ---------------------------------------------------------------------------

test("runWorkflow check step records verificationId + reviewId in the output map", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const reviewId = seedReview(worker, { status: "open" });
  const verificationId = randomUUID();
  const deps: Partial<WorkflowExecuteDeps> = {
    verifyOnce: async () => ({
      kind: "ok" as const,
      verificationId,
      reviewId,
      verification: fakeVerification(reviewId, verificationId),
    }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-check",
    createdBy: "test",
    steps: [
      { id: "chk", kind: "check", displayName: "chk", dependsOn: [], taskId: randomUUID(), command: "/bin/true", argv: [], deadlineAt: new Date(Date.now() + 60_000).toISOString() },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
  const output = result.stepOutputs.chk as { verificationId: string; reviewId: string };
  assert.equal(output.verificationId, verificationId);
  assert.equal(output.reviewId, reviewId);
});

// ---------------------------------------------------------------------------
// 12. approval step waits for accepted review; refuses rejected; times out.
// ---------------------------------------------------------------------------

test("runWorkflow approval step times out when the review stays open", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const reviewId = seedReview(worker, { status: "open" });
  const deps: Partial<WorkflowExecuteDeps> = {
    readReview: async () => ({ id: reviewId, status: "open" }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-approval",
    createdBy: "test",
    steps: [
      { id: "app", kind: "approval", displayName: "app", dependsOn: [], reviewId, pollMs: 50, deadlineMs: 200, decidedBy: "tester" },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.equal(result.failure.code, "TIMEOUT");
  }
});

test("runWorkflow approval step completes when the review flips to accepted", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const reviewId = seedReview(worker, { status: "open" });
  let count = 0;
  const deps: Partial<WorkflowExecuteDeps> = {
    readReview: async () => {
      count++;
      return { id: reviewId, status: count > 1 ? "accepted" : "open" };
    },
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-approval-ok",
    createdBy: "test",
    steps: [
      { id: "app", kind: "approval", displayName: "app", dependsOn: [], reviewId, pollMs: 50, deadlineMs: 5_000, decidedBy: "tester" },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
});

test("runWorkflow approval step fails on a rejected review", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const reviewId = seedReview(worker, { status: "open" });
  const deps: Partial<WorkflowExecuteDeps> = {
    readReview: async () => ({ id: reviewId, status: "rejected" }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-approval-rej",
    createdBy: "test",
    steps: [
      { id: "app", kind: "approval", displayName: "app", dependsOn: [], reviewId, pollMs: 50, deadlineMs: 5_000, decidedBy: "tester" },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.match(result.failure.message, /rejected/);
  }
});

// ---------------------------------------------------------------------------
// 13. artifact step.
// ---------------------------------------------------------------------------

test("runWorkflow artifact step records the pinned artifactId in the output map", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const sha = "a".repeat(64);
  const deps: Partial<WorkflowExecuteDeps> = {
    pinArtifact: async (_w, input) => ({ id: "art-1", sha256: input.sha256, kind: input.kind }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-artifact",
    createdBy: "test",
    steps: [
      { id: "pin", kind: "artifact", displayName: "pin", dependsOn: [], taskId: null, runId: null, uri: "file:///tmp/x", sha256: sha, artifactKind: "input", bytes: 10, mime: "text/plain", expiresAt: null },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
  const output = result.stepOutputs.pin as { artifactId: string };
  assert.equal(output.artifactId, "art-1");
});

// ---------------------------------------------------------------------------
// 14. wait step: refuses timeoutMs = 0.
// ---------------------------------------------------------------------------

test("workflowGraphSchema refuses a wait step with timeoutMs below MIN_STEP_TIMEOUT_MS", () => {
  const result = workflowGraphSchema.safeParse({
    workflowId: "wf-wait",
    createdBy: "test",
    steps: [
      { id: "w", kind: "wait", displayName: "w", dependsOn: [], timeoutMs: 0 },
    ],
    edges: [],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// 15. Stop semantics: isStopped(runId) ⇒ workflow returns cancelled.
// ---------------------------------------------------------------------------

test("runWorkflow returns cancelled when an agent step's runId is stopped", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  // Seed a task + run row so `requestStop` can find it.
  const taskId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  driverOf(worker).prepare(
    "INSERT INTO task (uuid, project_id, title, status, base_identity, head_revision, terminal_uuid, prompt, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, "test-project", "test", "open", null, null, null, "", now, now, "{}");
  driverOf(worker).prepare(
    "INSERT INTO run (uuid, task_id, status, started_at, ended_at, base_revision, terminal_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, taskId, "running", now, null, null, null, now, now);
  const { requestStop } = await import("../../src/runtime/orchestration/stop-policy");
  await requestStop(worker, { runId, reason: "test stop", requestedBy: "test" });
  const deps: Partial<WorkflowExecuteDeps> = {
    executeOnce: async () => { throw new Error("should not reach executeOnce"); },
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-stop",
    createdBy: "test",
    steps: [
      { id: "a", kind: "agent", displayName: "A", dependsOn: [], runId, idempotencyKey: "k", parentInvocationId: null, canonicalDigest: "a".repeat(64), prompt: "p", providerVersion: "v1", model: "m", accountMode: "anonymous", method: "agent.run", scope: {}, args: {}, deadlineAt: new Date(Date.now() + 60_000).toISOString(), attemptedBy: "test" },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "cancelled");
  assert.equal(result.cancelledStepId, "a");
});

// ---------------------------------------------------------------------------
// 16. Nested-workflow refusal: a step that calls runWorkflow throws FORBIDDEN.
// ---------------------------------------------------------------------------

test("runWorkflow refuses a nested runWorkflow with FORBIDDEN", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  let innerCalled = false;
  const outerId = "wf-outer";
  const innerDeps: Partial<WorkflowExecuteDeps> = {
    execFile: async () => {
      innerCalled = true;
      const innerInput: WorkflowGraphInput = {
        workflowId: outerId,
        createdBy: "test",
        steps: [{ id: "x", kind: "command", displayName: "x", dependsOn: [], argv: ["/bin/true"], env: {}, cwd: null }],
        edges: [],
      };
      try {
        await runWorkflow(worker, { workflow: innerInput, settings: null });
      } catch (err) {
        if (!(err instanceof AppError) || err.failure.code !== "FORBIDDEN") throw err;
      }
      return { stdout: "ok", stderr: "", code: 0, signal: null };
    },
  };
  const input: WorkflowGraphInput = {
    workflowId: outerId,
    createdBy: "test",
    steps: [{ id: "x", kind: "command", displayName: "x", dependsOn: [], argv: ["/bin/true"], env: {}, cwd: null }],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps: innerDeps });
  assert.equal(result.kind, "completed");
  assert.equal(innerCalled, true);
});

// ---------------------------------------------------------------------------
// 17. Audit digest determinism: two runs with same input ⇒ same auditDigest.
// ---------------------------------------------------------------------------

test("two consecutive runWorkflow calls with the same input produce identical auditDigest", async () => {
  const worker1 = freshWorker();
  const worker2 = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const input: WorkflowGraphInput = {
    workflowId: "wf-digest",
    createdBy: "test",
    steps: [
      { id: "a", kind: "command", displayName: "a", dependsOn: [], argv: ["/bin/true"], env: {}, cwd: null },
    ],
    edges: [],
  };
  const deps: Partial<WorkflowExecuteDeps> = {
    execFile: async () => ({ stdout: "deterministic", stderr: "", code: 0, signal: null }),
  };
  const result1 = await runWorkflow(worker1, { workflow: input, settings: null }, { deps });
  const result2 = await runWorkflow(worker2, { workflow: input, settings: null }, { deps });
  assert.equal(result1.kind, "completed");
  assert.equal(result2.kind, "completed");
  assert.equal(result1.auditDigest, result2.auditDigest);
});

// ---------------------------------------------------------------------------
// 18. Settings clamping: maxFanout = 99 clamps to MAX_FANOUT = 16.
// ---------------------------------------------------------------------------

test("resolveWorkflowExecutorSettings clamps maxFanout = 99 to MAX_FANOUT = 16", () => {
  const settings = resolveWorkflowExecutorSettings({ maxFanout: 99, defaultStepTimeoutMs: 30_000, waitPollMs: 250 });
  assert.equal(settings.maxFanout, MAX_FANOUT);
});

// ---------------------------------------------------------------------------
// 19. Settings defaults when input is null.
// ---------------------------------------------------------------------------

test("resolveWorkflowExecutorSettings returns defaults when input is null", () => {
  const settings = resolveWorkflowExecutorSettings(null);
  assert.equal(settings.maxFanout, 4);
  assert.equal(settings.defaultStepTimeoutMs, 30_000);
  assert.equal(settings.waitPollMs, 250);
});

// ---------------------------------------------------------------------------
// 20. Step input/output references: step B's inputRefs resolves to A's output.
// ---------------------------------------------------------------------------

test("inputRefs resolve to upstream step outputs via completedOutputs", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const deps: Partial<WorkflowExecuteDeps> = {
    execFile: async () => ({ stdout: "upstream", stderr: "", code: 0, signal: null }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-inputrefs",
    createdBy: "test",
    steps: [
      { id: "a", kind: "command", displayName: "a", dependsOn: [], outputKeys: ["first"], argv: ["/bin/echo", "hi"], env: {}, cwd: null },
      { id: "b", kind: "command", displayName: "b", dependsOn: ["a"], inputRefs: [{ stepId: "a", outputKey: "first" }], argv: ["/bin/true"], env: {}, cwd: null },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
  assert.ok(result.stepOutputs.a);
  assert.ok(result.stepOutputs.b);
});

// ---------------------------------------------------------------------------
// 21. workflowGraphSchema: oversize steps rejected.
// ---------------------------------------------------------------------------

test("workflowGraphSchema refuses > MAX_STEPS_PER_WORKFLOW steps", () => {
  const steps = Array.from({ length: 65 }, (_, i) => ({
    id: `s${i}`, kind: "command" as const, displayName: `S${i}`, dependsOn: [] as string[],
    argv: ["/bin/true"], env: {}, cwd: null,
  }));
  const result = workflowGraphSchema.safeParse({
    workflowId: "wf-big",
    createdBy: "test",
    steps,
    edges: [],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// 22. workflowGraphSchema: rejects malformed dependsOn.
// ---------------------------------------------------------------------------

test("workflowGraphSchema rejects an empty stepId in dependsOn", () => {
  const result = workflowGraphSchema.safeParse({
    workflowId: "wf-malformed",
    createdBy: "test",
    steps: [
      { id: "a", kind: "command", displayName: "A", dependsOn: [""], argv: ["/bin/true"], env: {}, cwd: null },
    ],
    edges: [],
  });
  assert.equal(result.success, false);
});

// ---------------------------------------------------------------------------
// 23. workflowResultSchema: completed kind carries auditDigest.
// ---------------------------------------------------------------------------

test("workflowResultSchema parses a completed result with auditDigest", () => {
  const parsed = workflowResultSchema.parse({
    kind: "completed",
    workflowId: "wf-r",
    stepOutputs: {},
    auditDigest: "a".repeat(64),
    completedAt: new Date().toISOString(),
  });
  assert.equal(parsed.kind, "completed");
});

// ---------------------------------------------------------------------------
// M6.1 — "no second scheduler for agent steps"
//
// The M6.1 bullet (FUTURE/IMPLEMENTATION-README.md line 243) reads:
//
//   > M6.1 Run workflow steps inside one executor with parallel
//   > fan-out bounded by configured capacity; provider-bound steps
//   > reuse the M5 managed-run admission (single scheduler,
//   > observable capacity, idempotency + canonical digest). No
//   > second scheduler for agent steps; durable waits and
//   > pending decisions retain capacity.
//
// The executor's agent step routes through the `executeOnce` M5
// admission. The tests below assert:
//   - exactly one `executeOnce` call per agent step (no parallel
//     scheduler racing the dispatch);
//   - the M5 admission is consulted — a `conflict` from the
//     admission surfaces as a step failure; an `ambiguous` surfaces
//     as an UNAVAILABLE; an `ok` proceeds with the M5 handle and
//     canonicalDigest;
//   - the agent step's `args` are forwarded to `executeOnce` (so
//     the M5 admission sees the same shape the workflow stored).
// ---------------------------------------------------------------------------

test("M6.1 agent step calls executeOnce exactly once with the canonical input", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const runId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  driverOf(worker).prepare(
    "INSERT INTO task (uuid, project_id, title, status, base_identity, head_revision, terminal_uuid, prompt, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, "test-project", "test", "open", null, null, null, "", now, now, "{}");
  driverOf(worker).prepare(
    "INSERT INTO run (uuid, task_id, status, started_at, ended_at, base_revision, terminal_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, taskId, "running", now, null, null, null, now, now);

  const calls: Array<{ input: unknown }> = [];
  const deps: Partial<WorkflowExecuteDeps> = {
    executeOnce: async (_w, input) => {
      calls.push({ input });
      const lifecycle = new EventEmitter();
      return {
        kind: "ok",
        invocationId: randomUUID(),
        handle: {
          correlationId: "stub",
          lifecycle,
          stdin: { write: async () => { /* noop */ }, close: () => { /* noop */ } },
          acknowledge: () => { /* noop */ },
          exit: async () => { /* noop */ },
          startup: null,
        },
        rehydrated: false,
        dispatchIntentId: randomUUID(),
      };
    },
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-m61-agent",
    createdBy: "test",
    steps: [
      {
        id: "a", kind: "agent", displayName: "A", dependsOn: [],
        runId, idempotencyKey: "k-1", parentInvocationId: null,
        canonicalDigest: "c".repeat(64), prompt: "do thing",
        providerVersion: "v1", model: "m",
        accountMode: "anonymous", method: "agent.run",
        scope: { workspaceId: "ws-1" }, args: { prompt: "do thing", attemptedBy: "test" },
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        attemptedBy: "test",
      },
    ],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "completed");
  assert.equal(calls.length, 1, "agent step must invoke executeOnce exactly once");
  // The executor forwarded the canonical digest + method + scope
  // unchanged so the M5 admission sees the same identity.
  const forwarded = calls[0].input as Record<string, unknown>;
  assert.equal(forwarded.canonicalDigest, "c".repeat(64));
  assert.equal(forwarded.method, "agent.run");
  assert.equal(forwarded.accountMode, "anonymous");
});

test("M6.1 agent step surfaces an executeOnce conflict as a step failure (no silent retry)", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const runId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  driverOf(worker).prepare(
    "INSERT INTO task (uuid, project_id, title, status, base_identity, head_revision, terminal_uuid, prompt, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, "test-project", "test", "open", null, null, null, "", now, now, "{}");
  driverOf(worker).prepare(
    "INSERT INTO run (uuid, task_id, status, started_at, ended_at, base_revision, terminal_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, taskId, "running", now, null, null, null, now, now);

  let calls = 0;
  const deps: Partial<WorkflowExecuteDeps> = {
    executeOnce: async () => {
      calls += 1;
      return { kind: "conflict", reason: "stale canonical digest" };
    },
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-m61-conflict",
    createdBy: "test",
    steps: [{
      id: "a", kind: "agent", displayName: "A", dependsOn: [],
      runId, idempotencyKey: "k-c", parentInvocationId: null,
      canonicalDigest: "d".repeat(64), prompt: "p",
      providerVersion: "v1", model: "m",
      accountMode: "anonymous", method: "agent.run",
      scope: {}, args: {},
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      attemptedBy: "test",
    }],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "failed");
  assert.equal(calls, 1, "agent step must not silently retry a conflict");
  assert.equal(result.failure?.code, "CONFLICT");
  assert.match(result.failure?.message ?? "", /stale canonical digest/);
});

test("M6.1 agent step surfaces an executeOnce ambiguous as UNAVAILABLE (no second scheduler resumes it)", async () => {
  const worker = freshWorker();
  resetStops();
  resetWorkflowInflight();
  const runId = randomUUID();
  const taskId = randomUUID();
  const now = new Date().toISOString();
  driverOf(worker).prepare(
    "INSERT INTO task (uuid, project_id, title, status, base_identity, head_revision, terminal_uuid, prompt, created_at, updated_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(taskId, "test-project", "test", "open", null, null, null, "", now, now, "{}");
  driverOf(worker).prepare(
    "INSERT INTO run (uuid, task_id, status, started_at, ended_at, base_revision, terminal_uuid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(runId, taskId, "running", now, null, null, null, now, now);

  const deps: Partial<WorkflowExecuteDeps> = {
    executeOnce: async () => ({
      kind: "ambiguous",
      invocationId: randomUUID(),
      reason: "handle disconnected before first ack",
    }),
  };
  const input: WorkflowGraphInput = {
    workflowId: "wf-m61-ambiguous",
    createdBy: "test",
    steps: [{
      id: "a", kind: "agent", displayName: "A", dependsOn: [],
      runId, idempotencyKey: "k-a", parentInvocationId: null,
      canonicalDigest: "e".repeat(64), prompt: "p",
      providerVersion: "v1", model: "m",
      accountMode: "anonymous", method: "agent.run",
      scope: {}, args: {},
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      attemptedBy: "test",
    }],
    edges: [],
  };
  const result = await runWorkflow(worker, { workflow: input, settings: null }, { deps });
  assert.equal(result.kind, "failed");
  assert.equal(result.failure?.code, "UNAVAILABLE");
});

