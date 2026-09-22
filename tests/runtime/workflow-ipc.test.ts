/**
 * M6.1 — `run-workflow` IPC dispatcher tests.
 *
 * Mirrors the M3c.2 / M3c.5 IPC test pattern (`managed-ipc.test.ts`):
 *
 *  1. The dispatcher handler delegates to `runWorkflow`.
 *  2. Zod validation of the input envelope happens at the protocol
 *     boundary (`parseRequest`); an oversized graph is rejected with
 *     `INVALID_REQUEST`.
 *  3. The handler re-parses the result through `workflowResultSchema`
 *     so a malformed in-process value cannot leak across the seam.
 *  4. `AppError` rejections surface as `{kind: "conflict", reason}`.
 *
 * The tests use the in-memory driver (no `node:sqlite`) so they run on
 * the dev shell at Node ≥ 20.19.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { API_VERSION, methods, parseRequest, type Request } from "../../src/shared/protocol";
import { ProtocolDispatcher } from "../../src/main/protocol-dispatcher";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { runWorkflow } from "../../src/runtime/orchestration/workflow-execute";
import { runWorkflowDurable } from "../../src/runtime/orchestration/workflow-durable";
import { findWorkflowRunByWorkflowId } from "../../src/runtime/db/workflow-runs";
import { workflowResultSchema } from "../../src/shared/workflow-executor-schema";
import { configureLogging } from "../../src/main/logging";

configureLogging({ write: async () => {} });

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function requestFor(method: string, args: unknown[]): Request {
  return {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: method as Request["method"],
    deadlineAt: Date.now() + 60_000,
    args,
  };
}

/**
 * Build a dispatcher that mirrors `RuntimeWorkspace.connect()`'s IPC
 * handler shape for the `run-workflow` method.
 */
function dispatcherFor(worker: DbWorker): ProtocolDispatcher {
  const dispatcher = new ProtocolDispatcher();
  dispatcher.register("run-workflow", async ([input]) => {
    try {
      const result = await runWorkflow(worker, input);
      const parsed = workflowResultSchema.parse(result);
      return { kind: "ok" as const, result: parsed };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { kind: "conflict" as const, reason: error.issues[0]?.message ?? "invalid input" };
      }
      if (error instanceof Error && error.name === "AppError") {
        return { kind: "conflict" as const, reason: error.message };
      }
      throw error;
    }
  });
  dispatcher.register("run-workflow-durable", async ([input]) => {
    try {
      const result = await runWorkflowDurable(worker, input);
      const parsed = workflowResultSchema.parse(result);
      return { kind: "ok" as const, result: parsed };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { kind: "conflict" as const, reason: error.issues[0]?.message ?? "invalid input" };
      }
      if (error instanceof Error && error.name === "AppError") {
        return { kind: "conflict" as const, reason: error.message };
      }
      throw error;
    }
  });
  return dispatcher;
}

test("IPC run-workflow: parseRequest rejects a graph with no steps", () => {
  const raw = {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: "run-workflow" as const,
    deadlineAt: Date.now() + 60_000,
    args: [{ workflow: { workflowId: "wf-1", steps: [], edges: [], createdBy: "tester" } }],
  };
  assert.throws(() => parseRequest(raw), /steps/i);
});

test("IPC run-workflow: parseRequest rejects an unknown step kind", () => {
  const raw = {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: "run-workflow" as const,
    deadlineAt: Date.now() + 60_000,
    args: [{
      workflow: {
        workflowId: "wf-1",
        steps: [{
          id: "s1", kind: "magic", displayName: "Magic step",
          // Note: `agent` body would be required; the kind enum check
          // fires first so this is a malformed union.
        }],
        edges: [],
        createdBy: "tester",
      },
    }],
  };
  assert.throws(() => parseRequest(raw));
});

test("IPC run-workflow: protocol timeout is MAX_DEADLINE_MS", () => {
  assert.equal(methods["run-workflow"].timeoutMs, 10 * 60 * 1000);
});

test("IPC run-workflow: completed wait-only workflow returns the structured ok envelope", async () => {
  const worker = freshWorker();
  try {
    const dispatcher = dispatcherFor(worker);
    const response = await dispatcher.dispatch(
      "run-workflow",
      requestFor("run-workflow", [{
        workflow: {
          workflowId: "wf-wait-only",
          steps: [{
            id: "w1", kind: "wait", displayName: "Tick once",
            timeoutMs: 5_000,
          }],
          edges: [],
          createdBy: "ipc-test",
        },
        settings: null,
      }]),
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok");
    const envelope = response.result as { kind: "ok"; result: unknown } | { kind: "conflict"; reason: string };
    assert.equal(envelope.kind, "ok");
    const result = workflowResultSchema.parse((envelope as { kind: "ok"; result: unknown }).result);
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") throw new Error("expected completed");
    assert.equal(result.workflowId, "wf-wait-only");
    assert.match(result.auditDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(result.stepOutputs, { w1: { waitedMs: 5_000 } });
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC run-workflow: cycle in dependsOn returns conflict with human reason", async () => {
  const worker = freshWorker();
  try {
    const dispatcher = dispatcherFor(worker);
    const response = await dispatcher.dispatch(
      "run-workflow",
      requestFor("run-workflow", [{
        workflow: {
          workflowId: "wf-cycle",
          steps: [
            {
              id: "a", kind: "wait", displayName: "A",
              dependsOn: ["b"],
              timeoutMs: 1_000,
            },
            {
              id: "b", kind: "wait", displayName: "B",
              dependsOn: ["a"],
              timeoutMs: 1_000,
            },
          ],
          edges: [],
          createdBy: "ipc-test",
        },
        settings: null,
      }]),
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok envelope");
    const envelope = response.result as { kind: "ok"; result: unknown } | { kind: "conflict"; reason: string };
    // The cycle is detected by `validateWorkflowGraph` inside `runWorkflow`,
    // which throws — the dispatcher handler translates that into a conflict.
    assert.equal(envelope.kind, "conflict");
    if (envelope.kind !== "conflict") throw new Error("expected conflict");
    assert.match(envelope.reason, /cycle|dependency/i);
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC run-workflow: a partial settings override is accepted as-is (Zod partial)", async () => {
  const worker = freshWorker();
  try {
    const dispatcher = dispatcherFor(worker);
    // The IPC envelope uses `workflowExecutorSettingsSchema.partial()`, so
    // a single field override parses cleanly; the remaining fields are
    // defaulted by `resolveWorkflowExecutorSettings` inside the executor.
    const response = await dispatcher.dispatch(
      "run-workflow",
      requestFor("run-workflow", [{
        workflow: {
          workflowId: "wf-partial",
          steps: [{
            id: "w1", kind: "wait", displayName: "Single tick",
            timeoutMs: 1_000,
          }],
          edges: [],
          createdBy: "ipc-test",
        },
        settings: { maxFanout: 2 },
      }]),
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok envelope");
    const envelope = response.result as { kind: "ok"; result: unknown } | { kind: "conflict"; reason: string };
    assert.equal(envelope.kind, "ok");
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC run-workflow: an out-of-range settings field is refused at the protocol layer", () => {
  // Strict Zod surface: the request envelope refuses `maxFanout: 9999`
  // because the partial schema inherits `min(1).max(MAX_FANOUT = 16)`.
  // Clamping happens *inside* `resolveWorkflowExecutorSettings` for
  // fields that pass the boundary, not at the boundary itself.
  const raw = {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: "run-workflow" as const,
    deadlineAt: Date.now() + 60_000,
    args: [{
      workflow: {
        workflowId: "wf-bad-settings",
        steps: [{
          id: "w1", kind: "wait", displayName: "Single tick",
          timeoutMs: 1_000,
        }],
        edges: [],
        createdBy: "ipc-test",
      },
      settings: { maxFanout: 9999 },
    }],
  };
  assert.throws(() => parseRequest(raw), /maxFanout/i);
});

// ---------------------------------------------------------------------------
// M6.4 — `run-workflow-durable` IPC channel.
// ---------------------------------------------------------------------------

test("IPC run-workflow-durable: protocol timeout is MAX_DEADLINE_MS", () => {
  assert.equal(methods["run-workflow-durable"].timeoutMs, 10 * 60 * 1000);
});

test("IPC run-workflow-durable: completed wait-only workflow returns the structured ok envelope and persists a workflow_run row", async () => {
  const worker = freshWorker();
  try {
    const dispatcher = dispatcherFor(worker);
    const response = await dispatcher.dispatch(
      "run-workflow-durable",
      requestFor("run-workflow-durable", [{
        workflow: {
          workflowId: "wf-durable-wait",
          steps: [{
            id: "w1", kind: "wait", displayName: "Tick once",
            timeoutMs: 5_000,
          }],
          edges: [],
          createdBy: "ipc-test",
        },
        settings: null,
      }]),
    );
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok");
    const envelope = response.result as { kind: "ok"; result: unknown } | { kind: "conflict"; reason: string };
    assert.equal(envelope.kind, "ok");
    const result = workflowResultSchema.parse((envelope as { kind: "ok"; result: unknown }).result);
    assert.equal(result.kind, "completed");
    if (result.kind !== "completed") throw new Error("expected completed");
    assert.equal(result.workflowId, "wf-durable-wait");
    // The durable dispatcher must have written a `workflow_run` row.
    const row = await findWorkflowRunByWorkflowId(worker, "wf-durable-wait");
    assert.ok(row, "expected workflow_run row for wf-durable-wait");
    assert.equal(row.status, "completed");
    assert.equal(row.terminal_outcome, "completed");
  } finally { /* memory driver — no resources to release */ }
});

test("IPC run-workflow-durable: parseRequest rejects an unknown step kind with the same envelope as run-workflow", () => {
  const raw = {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: "run-workflow-durable" as const,
    deadlineAt: Date.now() + 60_000,
    args: [{
      workflow: {
        workflowId: "wf-bad",
        steps: [{
          id: "s1", kind: "magic", displayName: "Magic step",
        }],
        edges: [],
        createdBy: "tester",
      },
    }],
  };
  assert.throws(() => parseRequest(raw));
});
