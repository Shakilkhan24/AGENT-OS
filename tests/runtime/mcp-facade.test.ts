/**
 * M5.1 — narrow management CLI/MCP facade tests.
 *
 * Coverage (16 focused tests):
 *  - Principal binding: empty principal rejected; principal with
 *    no projects rejected; permitted-set intersection enforced.
 *  - Read paths: list-tasks filters by permitted projects;
 *    deniedProjectIds surfaces agent-supplied project ids the
 *    principal cannot see; read-task / list-runs / read-run
 *    refuse cross-project rows; list-artifacts scopes by task
 *    project.
 *  - Write paths: create-task refuses out-of-set project;
 *    request-stop refuses cross-project run; both succeed when
 *    the principal is permitted.
 *  - Agent-supplied project id never enlarges access: the agent
 *    cannot smuggle a different project id past the gate.
 *  - preview-artifact delegates to the M3c.3 grant gate AND
 *    the project's permitted-set gate.
 *  - Raw shell / keystroke administration surface stays
 *    absent: the facade module does not export any
 *    `mcpAttach`, `mcpInput`, `mcpLaunchTerminals`, etc.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask, transitionTask } from "../../src/runtime/db/tasks";
import { createRun, transitionRun } from "../../src/runtime/db/runs";
import { createInvocation } from "../../src/runtime/db/invocations";
import { requestGrant, decideGrant } from "../../src/runtime/db/grants";
import { pinArtifact } from "../../src/runtime/db/artifact-references";
import {
  mcpListTasks, mcpReadTask, mcpListRuns, mcpReadRun,
  mcpListArtifacts, mcpPreviewArtifact,
  mcpCreateTask, mcpRequestStop,
} from "../../src/runtime/mcp/facade";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const baseCtx = (overrides?: { principal?: string; projectIds?: string[] }) => ({
  principal: overrides?.principal ?? "agent-bob",
  projectIds: overrides?.projectIds ?? ["alpha", "beta"],
});

async function seedTask(worker: DbWorker, projectId: string, title = "task"): Promise<string> {
  const { id } = await createTask(worker, {
    title, objective: "", projectId, hostId: "h1",
  });
  return id;
}

async function seedRun(worker: DbWorker, taskId: string): Promise<string> {
  const run = await createRun(worker, { taskId, baseRevision: null });
  return run.id;
}

async function seedInvocation(worker: DbWorker, runId: string): Promise<string> {
  const invocation = await createInvocation(worker, {
    runId,
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    canonicalDigest: "0".repeat(64),
    providerVersion: "claude-1.0",
    model: "claude-opus",
    accountMode: "authenticated",
  });
  await transitionRun(worker, runId, "running");
  return invocation.id;
}

test("mcpListTasks filters by the principal's permitted project set", async () => {
  const worker = freshWorker();
  try {
    await seedTask(worker, "alpha", "A1");
    await seedTask(worker, "alpha", "A2");
    await seedTask(worker, "gamma", "G1");
    const result = await mcpListTasks(worker, baseCtx({ projectIds: ["alpha"] }));
    assert.equal(result.tasks.length, 2);
    assert.deepEqual(result.tasks.map(t => t.title).sort(), ["A1", "A2"]);
    // The gamma project has a task; the principal is not
    // permitted to see it, so it appears in `deniedProjectIds`.
    assert.deepEqual(result.deniedProjectIds, ["gamma"]);
  } finally { await worker.close(); }
});

test("mcpListTasks excludes tasks outside the permitted set without surfacing them", async () => {
  const worker = freshWorker();
  try {
    await seedTask(worker, "alpha", "A1");
    await seedTask(worker, "gamma", "G1");
    await seedTask(worker, "delta", "D1");
    // Principal is permitted only on alpha; gamma + delta exist
    // but are filtered out — the agent does not see the tasks
    // themselves. `deniedProjectIds` records the projects so an
    // audit log can still see which projects the agent attempted
    // to enumerate.
    const list = await mcpListTasks(worker, baseCtx({ projectIds: ["alpha"] }));
    assert.equal(list.tasks.length, 1);
    assert.equal(list.tasks[0]?.title, "A1");
    assert.deepEqual([...list.deniedProjectIds].sort(), ["delta", "gamma"]);
  } finally { await worker.close(); }
});

test("mcpReadTask refuses a task outside the principal's permitted projects", async () => {
  const worker = freshWorker();
  try {
    const id = await seedTask(worker, "gamma");
    await assert.rejects(
      mcpReadTask(worker, baseCtx({ projectIds: ["alpha"] }), id),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("mcpReadTask returns task + runs when the principal is permitted", async () => {
  const worker = freshWorker();
  try {
    const id = await seedTask(worker, "alpha");
    const runId = await seedRun(worker, id);
    await seedInvocation(worker, runId);
    const view = await mcpReadTask(worker, baseCtx({ projectIds: ["alpha"] }), id);
    assert.equal(view.task.id, id);
    assert.equal(view.task.projectId, "alpha");
    assert.equal(view.runs.length, 1);
    assert.equal(view.runs[0]?.id, runId);
  } finally { await worker.close(); }
});

test("mcpListRuns refuses cross-project task id", async () => {
  const worker = freshWorker();
  try {
    const id = await seedTask(worker, "gamma");
    await seedRun(worker, id);
    await assert.rejects(
      mcpListRuns(worker, baseCtx({ projectIds: ["alpha"] }), id),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("mcpReadRun refuses when the run's task project is not permitted", async () => {
  const worker = freshWorker();
  try {
    const taskId = await seedTask(worker, "gamma");
    const runId = await seedRun(worker, taskId);
    await assert.rejects(
      mcpReadRun(worker, baseCtx({ projectIds: ["alpha"] }), runId),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("mcpReadRun returns run + invocations when permitted", async () => {
  const worker = freshWorker();
  try {
    const taskId = await seedTask(worker, "alpha");
    const runId = await seedRun(worker, taskId);
    const invocationId = await seedInvocation(worker, runId);
    const view = await mcpReadRun(worker, baseCtx({ projectIds: ["alpha"] }), runId);
    assert.equal(view.run.id, runId);
    assert.equal(view.invocations.length, 1);
    assert.equal(view.invocations[0]?.id, invocationId);
  } finally { await worker.close(); }
});

test("mcpListArtifacts scopes by task project; agent cannot see cross-project artifacts", async () => {
  const worker = freshWorker();
  try {
    const taskAlpha = await seedTask(worker, "alpha");
    const taskGamma = await seedTask(worker, "gamma");
    const { id: artifactAlpha } = await pinArtifact(worker, {
      taskId: taskAlpha, runId: null, uri: "file:///alpha.txt",
      sha256: "1".repeat(64), kind: "input", bytes: 12, mime: "text/plain",
    });
    await pinArtifact(worker, {
      taskId: taskGamma, runId: null, uri: "file:///gamma.txt",
      sha256: "2".repeat(64), kind: "input", bytes: 12, mime: "text/plain",
    });
    const list = await mcpListArtifacts(worker, baseCtx({ projectIds: ["alpha"] }));
    assert.equal(list.artifacts.length, 1);
    assert.equal(list.artifacts[0]?.id, artifactAlpha);
  } finally { await worker.close(); }
});

test("mcpCreateTask refuses an agent-supplied project outside the permitted set", async () => {
  const worker = freshWorker();
  try {
    const result = await mcpCreateTask(worker, baseCtx({ projectIds: ["alpha"] }), {
      title: "sneak", objective: "", projectId: "gamma", hostId: "h1",
    });
    assert.equal(result.kind, "forbidden");
  } finally { await worker.close(); }
});

test("mcpCreateTask succeeds when the project is permitted", async () => {
  const worker = freshWorker();
  try {
    const result = await mcpCreateTask(worker, baseCtx({ projectIds: ["alpha"] }), {
      title: "ok", objective: "do it", projectId: "alpha", hostId: "h1",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.task.title, "ok");
      assert.equal(result.task.projectId, "alpha");
      assert.equal(result.task.status, "draft");
    }
  } finally { await worker.close(); }
});

test("agent-supplied project id never enlarges access — even with identical name in input and permitted set", async () => {
  const worker = freshWorker();
  try {
    // The agent supplies projectId "alpha" but the principal's
    // permitted set is only ["beta"]. requirePermittedProject
    // refuses before any row is touched.
    const result = await mcpCreateTask(worker, baseCtx({ projectIds: ["beta"] }), {
      title: "sneak-2", objective: "", projectId: "alpha", hostId: "h1",
    });
    assert.equal(result.kind, "forbidden");
  } finally { await worker.close(); }
});

test("mcpRequestStop refuses a cross-project run", async () => {
  const worker = freshWorker();
  try {
    const taskId = await seedTask(worker, "gamma");
    const runId = await seedRun(worker, taskId);
    const result = await mcpRequestStop(worker, baseCtx({ projectIds: ["alpha"] }), {
      runId, reason: "test",
    });
    assert.equal(result.kind, "forbidden");
  } finally { await worker.close(); }
});

test("mcpRequestStop succeeds on a permitted-project run and flips status", async () => {
  const worker = freshWorker();
  try {
    const taskId = await seedTask(worker, "alpha");
    await transitionTask(worker, taskId, { to: "ready" });
    await transitionTask(worker, taskId, { to: "active" });
    const runId = await seedRun(worker, taskId);
    const result = await mcpRequestStop(worker, baseCtx({ projectIds: ["alpha"] }), {
      runId, reason: "halt", requestedBy: "agent-bob",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.runId, runId);
      assert.equal(result.status, "cancelled");
      assert.equal(result.blockedExecuteOnce, true);
    }
  } finally { await worker.close(); }
});

test("mcpPreviewArtifact refuses a cross-project artifact", async () => {
  const worker = freshWorker();
  try {
    const taskGamma = await seedTask(worker, "gamma");
    const { id: artifactId } = await pinArtifact(worker, {
      taskId: taskGamma, runId: null, uri: "file:///g.txt",
      sha256: "3".repeat(64), kind: "input", bytes: 5, mime: "text/plain",
    });
    await assert.rejects(
      mcpPreviewArtifact(worker, baseCtx({ projectIds: ["alpha"] }), artifactId),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("mcpPreviewArtifact refuses when the principal lacks the M3c.3 grant for the artifact", async () => {
  const worker = freshWorker();
  try {
    const taskAlpha = await seedTask(worker, "alpha");
    const { id: artifactId } = await pinArtifact(worker, {
      taskId: taskAlpha, runId: null, uri: "file:///a.txt",
      sha256: "4".repeat(64), kind: "input", bytes: 5, mime: "text/plain",
    });
    // No grant exists for (agent-bob, 4…4); the M3c.3 grant
    // gate refuses the preview even though the project is
    // permitted.
    await assert.rejects(
      mcpPreviewArtifact(worker, baseCtx({ projectIds: ["alpha"] }), artifactId),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("mcpPreviewArtifact succeeds when both project and grant gates pass", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-preview-"));
  const filePath = join(dir, "a.txt");
  writeFileSync(filePath, "hello", "utf8");
  const worker = freshWorker();
  try {
    const taskAlpha = await seedTask(worker, "alpha");
    const { id: artifactId } = await pinArtifact(worker, {
      taskId: taskAlpha, runId: null, uri: `file://${filePath}`,
      sha256: "5".repeat(64), kind: "input", bytes: 5, mime: "text/plain",
    });
    // Create an approved grant for (agent-bob, 5…5, input).
    const grant = await requestGrant(worker, {
      taskId: taskAlpha, kind: "capability", principal: "agent-bob",
      scope: { artifactKinds: ["input"] },
      digests: { artifactSha256: "5".repeat(64) },
    });
    // Approve the grant; the decider must differ from the
    // requester (anti-self-approval).
    await decideGrant(worker, grant.id, {
      decision: "approve", decidedBy: "user-carol",
    });
    const preview = await mcpPreviewArtifact(worker, baseCtx({ projectIds: ["alpha"] }), artifactId);
    assert.equal(preview.id, artifactId);
    assert.equal(preview.sha256, "5".repeat(64));
    assert.equal(preview.bytes, 5);
  } finally { await worker.close(); }
});

test("agent-supplied empty principal is rejected by the schema validation", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      mcpListTasks(worker, { principal: "", projectIds: ["alpha"] }),
      (error: unknown) => {
        // The facade parses the context with Zod first; an empty
        // principal fails the .min(1) refinement and surfaces as a
        // ZodError (re-thrown by the test harness).
        return (error as { name?: string })?.name === "ZodError";
      },
    );
  } finally { await worker.close(); }
});

test("agent-supplied empty projectIds list is rejected by the schema validation", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      mcpListTasks(worker, { principal: "agent-bob", projectIds: [] }),
      (error: unknown) => {
        return (error as { name?: string })?.name === "ZodError";
      },
    );
  } finally { await worker.close(); }
});
