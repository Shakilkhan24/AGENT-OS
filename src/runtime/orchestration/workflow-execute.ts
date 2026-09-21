/**
 * M6.1 — workflow executor (`runWorkflow`).
 *
 * The M6.1 bullet (FUTURE/IMPLEMENTATION-README.md line 243) reads:
 *
 * > M6.1 Extract the successful M3 prepare/agent/check/review path
 * > into one small workflow executor. Steps are `agent`, `command`,
 * > `check`, `approval`, `artifact` and durable `wait`; validate IDs,
 * > dependencies, cycles, input/output references, timeouts and bounded
 * > fan-out. Agent steps use existing managed runs; do not build a
 * > second scheduler or agent lifecycle.
 *
 * Execution model (D-1): inline, in-memory. `runWorkflow` returns when
 * the workflow reaches a terminal state (`completed | failed | cancelled`).
 * No persistence beyond audit events.
 *
 * The executor mirrors the existing primitive seams rather than
 * building a second scheduler:
 *
 *  - `agent` → `executeOnce` (M3b.2 — `isStopped` is consulted first).
 *  - `command` → `execFile` from `node:child_process`, bounded stdout/stderr.
 *  - `check` → `verifyOnce` (M3c.2). Output carries `verificationId`
 *    + `reviewId` so a later `wait` step can block on `review.status
 *    === "accepted"`.
 *  - `approval` → polls `readReview` until `accepted | rejected` or
 *    the step deadline.
 *  - `artifact` → `pinArtifact` (idempotent on `(uri, sha256)`).
 *  - `wait` → pure `setTimeout`-based timer.
 *
 * The "no nested workflow execution" guard is a process-global
 * `Set<workflowId>` populated on entry and popped on `finally` — a
 * recursive `runWorkflow` call throws `FORBIDDEN`.
 *
 * Audit events: `workflow.started`, `workflow.step.completed`,
 * `workflow.step.failed`, `workflow.completed`. Each event's
 * `payloadDigest` is computed via `stableStringify` over the canonical
 * payload **excluding `at`**, so re-emitted events with the same shape
 * produce the same digest (mirrors M5.5 / M5.6).
 */
import { createHash } from "node:crypto";
import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import type { DbWorker } from "../db/worker";
import { executeOnce, type ExecuteOnceInput, type ExecuteOnceResult } from "./execute-once";
import { verifyOnce, type VerifyOnceInput, type VerifyOnceResult } from "./verifier-execute";
import { pinArtifact, type PinArtifactInput } from "../db/artifact-references";
import { readReview } from "../db/reviews";
import { isStopped } from "./stop-policy";
import {
  workflowGraphSchema,
  resolveWorkflowExecutorSettings,
  type WorkflowExecutorSettings,
  type WorkflowExecutorSettingsInput,
  type WorkflowGraph,
  type WorkflowGraphInput,
  type WorkflowResult,
  type WorkflowStep,
  workflowResultSchema,
} from "../../shared/workflow-executor-schema";
import {
  resolveReadySteps,
  topologicalOrder,
  validateWorkflowGraph,
} from "../db/workflow-graph";

// ---------------------------------------------------------------------------
// Test seam: dependency injection. Defaults to the real primitives.
// ---------------------------------------------------------------------------

export interface WorkflowExecuteDeps {
  readonly executeOnce: (worker: DbWorker, input: ExecuteOnceInput) => Promise<ExecuteOnceResult>;
  readonly verifyOnce: (worker: DbWorker, input: VerifyOnceInput) => Promise<VerifyOnceResult>;
  readonly pinArtifact: (worker: DbWorker, input: PinArtifactInput) => Promise<{ id: string; sha256: string; kind: string }>;
  readonly readReview: (worker: DbWorker, reviewId: string) => Promise<{ id: string; status: string } | undefined>;
  readonly execFile: (bin: string, args: ReadonlyArray<string>, opts: {
    cwd?: string | null;
    env?: Record<string, string>;
    timeout?: number;
    maxBuffer?: number;
  }) => Promise<{ stdout: string; stderr: string; code: number | null; signal: NodeJS.Signals | null }>;
  readonly setTimeout: (fn: () => void, ms: number) => NodeJS.Timeout | number;
  readonly clearTimeout: (handle: NodeJS.Timeout | number) => void;
  readonly nowIso: () => string;
}

const defaultExecFile = promisify(nodeExecFile) as unknown as (
  bin: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer; code: number | null; signal: NodeJS.Signals | null }>;

const defaultDeps: WorkflowExecuteDeps = {
  executeOnce,
  verifyOnce,
  pinArtifact: pinArtifact as unknown as WorkflowExecuteDeps["pinArtifact"],
  readReview: readReview as unknown as WorkflowExecuteDeps["readReview"],
  execFile: async (bin, args, opts) => {
    const result = await defaultExecFile(bin, args, {
      cwd: opts.cwd ?? undefined,
      env: opts.env,
      timeout: opts.timeout,
      maxBuffer: opts.maxBuffer,
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
      code: typeof result.code === "number" ? result.code : null,
      signal: result.signal,
    };
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  nowIso: () => new Date().toISOString(),
};

// ---------------------------------------------------------------------------
// In-flight workflow guard (process-global).
// ---------------------------------------------------------------------------

const inFlightWorkflows = new Set<string>();

/** Test seam: read the in-flight set. */
export function inflightWorkflowIds(): ReadonlyArray<string> {
  return [...inFlightWorkflows];
}

/** Test seam: clear the in-flight set. */
export function resetWorkflowInflight(): void {
  inFlightWorkflows.clear();
}

// ---------------------------------------------------------------------------
// Audit event writer
// ---------------------------------------------------------------------------

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/**
 * Write one workflow audit row. Mirrors `writeAuditEvent` in
 * `runtime/orchestration/hook-execute.ts:208` — `seq` is the max+1
 * inside the same transaction so a write-collision is impossible.
 *
 * The `payloadDigest` is computed over the canonical payload
 * **excluding `at`**, so two events with the same logical shape
 * produce the same digest (drift detection compares content, not
 * capture moment).
 */
async function writeWorkflowEvent(
  worker: DbWorker,
  args: {
    type: "workflow.started" | "workflow.step.completed" | "workflow.step.failed" | "workflow.completed";
    workflowId: string;
    payload: Record<string, unknown>;
  },
): Promise<{ seq: number; payloadDigest: string }> {
  const driver = driverOf(worker);
  const at = defaultDeps.nowIso();
  const { payloadDigest, ...payloadNoDigest } = computePayloadDigest(args.payload);
  let seq = -1;
  await worker.transaction(tx => {
    void tx;
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    seq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      seq, at, args.workflowId, "runtime-workflow",
      null, null, null, args.type,
      JSON.stringify({ ...payloadNoDigest, payloadDigest }),
    );
  });
  return { seq, payloadDigest };
}

function computePayloadDigest(payload: Record<string, unknown>): {
  payloadDigest: string;
  payloadNoDigest: Record<string, unknown>;
} {
  // Exclude `at` from the digest surface; include everything else.
  const { at: _at, ...rest } = payload;
  void _at;
  const digest = createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
  return { payloadDigest: digest, payloadNoDigest: rest };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RunWorkflowOptions {
  /** Caller-supplied override; null/absent ⇒ defaults + clamp. */
  settings?: WorkflowExecutorSettingsInput | null;
  /** Test seam — swap the underlying primitives. */
  deps?: Partial<WorkflowExecuteDeps>;
}

const RUN_WORKFLOW_INPUT = z
  .object({
    workflowId: z.string().min(1).max(128),
    steps: z.array(z.unknown()).min(1).max(64),
    edges: z.array(z.unknown()).max(256).default([]),
    createdBy: z.string().min(1).max(256),
    settings: z.unknown().nullable().default(null),
  })
  .strict();

/**
 * Run a workflow to completion. Returns the typed
 * `WorkflowResult` discriminated on `kind`. Throws
 * `AppError("INVALID_REQUEST")` for any pre-dispatch validation
 * failure (graph shape, settings out of range, etc.).
 */
export async function runWorkflow(
  worker: DbWorker,
  input: WorkflowGraphInput | RunWorkflowEnvelope,
  options: RunWorkflowOptions = {},
): Promise<WorkflowResult> {
  const envelope: RunWorkflowEnvelope = "workflow" in input
    ? input
    : { workflow: input };
  const parsed = RUN_WORKFLOW_INPUT.parse({
    workflowId: envelope.workflow.workflowId,
    steps: envelope.workflow.steps,
    edges: envelope.workflow.edges,
    createdBy: envelope.workflow.createdBy,
    settings: envelope.settings ?? null,
  });
  // Re-parse the workflow graph itself with the strict schema (catches
  // body-level errors that the envelope parser deliberately relaxed).
  const graph: WorkflowGraph = workflowGraphSchema.parse({
    workflowId: parsed.workflowId,
    steps: parsed.steps,
    edges: parsed.edges,
    createdBy: parsed.createdBy,
  });
  const settings = resolveWorkflowExecutorSettings(envelope.settings ?? null);
  const deps = mergeDeps(options.deps);
  return runWorkflowInner(worker, graph, settings, deps, envelope.settings ?? null);
}

/** Wrapper envelope so callers can pass `settings` alongside the graph. */
export interface RunWorkflowEnvelope {
  readonly workflow: WorkflowGraphInput;
  readonly settings?: WorkflowExecutorSettingsInput | null;
}

async function runWorkflowInner(
  worker: DbWorker,
  graph: WorkflowGraph,
  settings: WorkflowExecutorSettings,
  deps: WorkflowExecuteDeps,
  rawSettings: WorkflowExecutorSettingsInput | null,
): Promise<WorkflowResult> {
  if (inFlightWorkflows.has(graph.workflowId))
    throw new AppError("FORBIDDEN", "workflow.executor: recursive execution refused");

  // Pre-dispatch: validate the graph, refuse cycles + oversize before any step runs.
  validateWorkflowGraph(graph.steps, graph.edges);
  const ordered = topologicalOrder(graph.steps, graph.edges);

  inFlightWorkflows.add(graph.workflowId);
  const completedOutputs: Record<string, unknown> = {};
  const completedIds = new Set<string>();
  const stepStartedAt = new Map<string, string>();
  let inFlight = 0;
  let cancelled = false;
  let cancelledStepId: string | null = null;
  let failure: { code: string; message: string; stepId: string } | null = null;

  try {
    // Emit `workflow.started`.
    const startedDigest = await writeWorkflowEvent(worker, {
      type: "workflow.started",
      workflowId: graph.workflowId,
      payload: {
        workflowId: graph.workflowId,
        stepCount: graph.steps.length,
        edgeCount: graph.edges.length,
        createdBy: graph.createdBy,
        settings: {
          maxFanout: settings.maxFanout,
          defaultStepTimeoutMs: settings.defaultStepTimeoutMs,
          waitPollMs: settings.waitPollMs,
        },
      },
    });
    void startedDigest;

    const remaining: WorkflowStep[] = [...ordered];
    while (remaining.length > 0) {
      // Cancellation check — `isStopped(parsed.runId)` for any step with one.
      const cancelledStep = findCancelledStep(remaining, graph, completedIds);
      if (cancelledStep) {
        cancelled = true;
        cancelledStepId = cancelledStep;
        break;
      }

      // Pull runnable steps capped by fan-out.
      const ready = resolveReadySteps(remaining, completedIds);
      const slots = Math.max(0, settings.maxFanout - inFlight);
      const toDispatch = ready.slice(0, slots);
      if (toDispatch.length === 0) {
        // No ready steps; nothing more to do. If `remaining` is
        // non-empty, the only path forward is via failure
        // propagation; break and let the failure branch write the
        // terminal event.
        if (failure) break;
        // Otherwise we're done.
        break;
      }
      inFlight += toDispatch.length;

      const settled = await Promise.allSettled(toDispatch.map((step) => runStep(worker, step, graph, completedOutputs, completedIds, settings, deps)));
      inFlight -= toDispatch.length;

      for (let i = 0; i < settled.length; i++) {
        const step = toDispatch[i];
        const outcome = settled[i];
        stepStartedAt.set(step.id, deps.nowIso());
        if (outcome.status === "fulfilled") {
          const output = outcome.value;
          completedOutputs[step.id] = output;
          completedIds.add(step.id);
          // Remove from remaining.
          const idx = remaining.findIndex((s) => s.id === step.id);
          if (idx >= 0) remaining.splice(idx, 1);
          await writeWorkflowEvent(worker, {
            type: "workflow.step.completed",
            workflowId: graph.workflowId,
            payload: {
              workflowId: graph.workflowId,
              stepId: step.id,
              kind: step.kind,
              outputDigest: digestOutput(output),
              at: deps.nowIso(),
            },
          });
        } else {
          const error = outcome.reason;
          const message = error instanceof Error ? error.message : String(error);
          const code = error instanceof AppError ? error.failure.code : "INTERNAL";
          if (!failure) {
            failure = { code, message, stepId: step.id };
          }
          await writeWorkflowEvent(worker, {
            type: "workflow.step.failed",
            workflowId: graph.workflowId,
            payload: {
              workflowId: graph.workflowId,
              stepId: step.id,
              kind: step.kind,
              failure: { code, message },
              at: deps.nowIso(),
            },
          });
          // Remove the failed step from remaining so the loop can make progress.
          const idx = remaining.findIndex((s) => s.id === step.id);
          if (idx >= 0) remaining.splice(idx, 1);
        }
      }
    }

    // Build the terminal result.
    const now = deps.nowIso();
    if (cancelled) {
      const auditDigest = digestCompletion({
        workflowId: graph.workflowId,
        outcome: "cancelled",
        stepCount: graph.steps.length,
        stepOutputs: digestOutputMap(completedOutputs),
      });
      await writeWorkflowEvent(worker, {
        type: "workflow.completed",
        workflowId: graph.workflowId,
        payload: {
          workflowId: graph.workflowId,
          outcome: "cancelled",
          stepCount: graph.steps.length,
          cancelledStepId,
          stepOutputs: completedOutputs,
          auditDigest,
          at: now,
        },
      });
      return workflowResultSchema.parse({
        kind: "cancelled",
        workflowId: graph.workflowId,
        stepOutputs: completedOutputs,
        auditDigest,
        cancelledAt: now,
        cancelledStepId,
      });
    }

    if (failure) {
      const auditDigest = digestCompletion({
        workflowId: graph.workflowId,
        outcome: "failed",
        stepCount: graph.steps.length,
        stepOutputs: digestOutputMap(completedOutputs),
      });
      await writeWorkflowEvent(worker, {
        type: "workflow.completed",
        workflowId: graph.workflowId,
        payload: {
          workflowId: graph.workflowId,
          outcome: "failed",
          stepCount: graph.steps.length,
          failedStepId: failure.stepId,
          failure: { code: failure.code, message: failure.message },
          stepOutputs: completedOutputs,
          auditDigest,
          at: now,
        },
      });
      return workflowResultSchema.parse({
        kind: "failed",
        workflowId: graph.workflowId,
        stepOutputs: completedOutputs,
        auditDigest,
        failedAt: now,
        failedStepId: failure.stepId,
        failure: { code: failure.code, message: failure.message },
      });
    }

    const auditDigest = digestCompletion({
      workflowId: graph.workflowId,
      outcome: "completed",
      stepCount: graph.steps.length,
      stepOutputs: digestOutputMap(completedOutputs),
    });
    await writeWorkflowEvent(worker, {
      type: "workflow.completed",
      workflowId: graph.workflowId,
      payload: {
        workflowId: graph.workflowId,
        outcome: "completed",
        stepCount: graph.steps.length,
        stepOutputs: completedOutputs,
        auditDigest,
        at: now,
      },
    });
    return workflowResultSchema.parse({
      kind: "completed",
      workflowId: graph.workflowId,
      stepOutputs: completedOutputs,
      auditDigest,
      completedAt: now,
    });
  } finally {
    inFlightWorkflows.delete(graph.workflowId);
  }
  void rawSettings;
  void stepStartedAt;
}

// ---------------------------------------------------------------------------
// Per-step dispatch (the six step kinds)
// ---------------------------------------------------------------------------

async function runStep(
  worker: DbWorker,
  step: WorkflowStep,
  graph: WorkflowGraph,
  completedOutputs: Record<string, unknown>,
  completedIds: Set<string>,
  settings: WorkflowExecutorSettings,
  deps: WorkflowExecuteDeps,
): Promise<Record<string, unknown>> {
  // Resolve `inputRefs` into the step's `inputs` payload.
  const inputs = resolveInputRefs(step, completedOutputs, completedIds);

  switch (step.kind) {
    case "agent": {
      const agentStep = step as Extract<WorkflowStep, { kind: "agent" }>;
      if (isStopped(agentStep.runId))
        throw new AppError("CANCELLED", `run ${agentStep.runId} is stopped; agent step refused`);
      const input: ExecuteOnceInput = {
        runId: agentStep.runId,
        idempotencyKey: agentStep.idempotencyKey,
        canonicalDigest: agentStep.canonicalDigest,
        providerVersion: agentStep.providerVersion,
        model: agentStep.model,
        accountMode: agentStep.accountMode,
        method: agentStep.method,
        args: { ...(agentStep.args as Record<string, unknown> ?? {}), ...inputs, prompt: agentStep.prompt, attemptedBy: agentStep.attemptedBy },
        scope: agentStep.scope as Record<string, unknown> | undefined ?? {},
        deadlineAt: agentStep.deadlineAt,
        parentInvocationId: agentStep.parentInvocationId,
      };
      const result = await deps.executeOnce(worker, input);
      if (result.kind === "conflict")
        throw new AppError("CONFLICT", result.reason);
      if (result.kind === "ambiguous")
        throw new AppError("UNAVAILABLE", result.reason);
      return {
        invocationId: result.invocationId,
        dispatchIntentId: result.dispatchIntentId,
        rehydrated: result.rehydrated,
      };
    }
    case "command": {
      const cmdStep = step as Extract<WorkflowStep, { kind: "command" }>;
      const bin = cmdStep.argv[0];
      const args = cmdStep.argv.slice(1);
      const result = await deps.execFile(bin, args, {
        cwd: cmdStep.cwd,
        env: cmdStep.env as Record<string, string>,
        timeout: step.timeoutMs ?? settings.defaultStepTimeoutMs,
        maxBuffer: Math.max(cmdStep.stdoutByteCap, cmdStep.stderrByteCap),
      });
      const stdout = result.stdout.slice(0, cmdStep.stdoutByteCap);
      const stderr = result.stderr.slice(0, cmdStep.stderrByteCap);
      if (result.code !== 0)
        throw new AppError("CONFLICT",
          `Command exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}: ${stderr.slice(0, 1024)}`);
      return {
        stdout,
        stderr,
        exitCode: result.code,
        signal: result.signal,
      };
    }
    case "check": {
      const checkStep = step as Extract<WorkflowStep, { kind: "check" }>;
      const input: VerifyOnceInput = {
        taskId: checkStep.taskId,
        runId: checkStep.runId ?? undefined,
        recipeId: checkStep.recipeId,
        command: checkStep.command,
        argv: checkStep.argv,
        env: {},
        deadlineAt: checkStep.deadlineAt,
      };
      const result = await deps.verifyOnce(worker, input);
      if (result.kind === "conflict")
        throw new AppError("CONFLICT", result.reason);
      return {
        verificationId: result.verificationId,
        reviewId: result.reviewId,
        status: result.verification.status,
      };
    }
    case "approval": {
      const approvalStep = step as Extract<WorkflowStep, { kind: "approval" }>;
      const reviewId = approvalStep.reviewId;
      if (!reviewId)
        throw new AppError("INVALID_REQUEST",
          "approval step requires reviewId (attentionId-only path deferred)");
      const deadline = Date.now() + approvalStep.deadlineMs;
      while (Date.now() < deadline) {
        const review = await deps.readReview(worker, reviewId);
        if (!review)
          throw new AppError("NOT_FOUND", `Review ${reviewId} not found`);
        if (review.status === "accepted")
          return { reviewId, status: "accepted" };
        if (review.status === "rejected" || review.status === "invalidated")
          throw new AppError("CONFLICT",
            `Review ${reviewId} reached terminal state "${review.status}"; approval refused`);
        await waitForMs(deps, approvalStep.pollMs);
      }
      throw new AppError("TIMEOUT",
        `approval timed out after ${approvalStep.deadlineMs}ms waiting for review ${reviewId}`);
    }
    case "artifact": {
      const artifactStep = step as Extract<WorkflowStep, { kind: "artifact" }>;
      const pinned = await deps.pinArtifact(worker, {
        taskId: artifactStep.taskId,
        runId: artifactStep.runId,
        uri: artifactStep.uri,
        sha256: artifactStep.sha256,
        kind: artifactStep.artifactKind,
        bytes: artifactStep.bytes,
        mime: artifactStep.mime,
        expiresAt: artifactStep.expiresAt,
      });
      return {
        artifactId: pinned.id,
        sha256: pinned.sha256,
        kind: pinned.kind,
      };
    }
    case "wait": {
      const waitStep = step as Extract<WorkflowStep, { kind: "wait" }>;
      const ms = waitStep.timeoutMs;
      await waitForMs(deps, ms);
      return { waitedMs: ms };
    }
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      void graph;
      throw new AppError("INVALID_REQUEST", `Unknown step kind: ${(step as { kind: string }).kind}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveInputRefs(
  step: WorkflowStep,
  completedOutputs: Record<string, unknown>,
  completedIds: Set<string>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const ref of step.inputRefs) {
    if (!completedIds.has(ref.stepId))
      throw new AppError("INVALID_REQUEST",
        `step ${step.id} inputRefs references ${ref.stepId} which has not completed`);
    const upstream = completedOutputs[ref.stepId];
    if (!upstream || typeof upstream !== "object")
      throw new AppError("INVALID_REQUEST",
        `step ${step.id} inputRefs references ${ref.stepId} which has no output map`);
    const value = (upstream as Record<string, unknown>)[ref.outputKey];
    inputs[ref.outputKey] = value;
  }
  return inputs;
}

function findCancelledStep(
  remaining: ReadonlyArray<WorkflowStep>,
  graph: WorkflowGraph,
  completedIds: Set<string>,
): string | null {
  for (const step of remaining) {
    if (step.kind !== "agent") continue;
    if (!completedIds.has(step.id) && isStopped(step.runId)) return step.id;
  }
  void graph;
  return null;
}

function waitForMs(deps: WorkflowExecuteDeps, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    deps.setTimeout(resolve, ms);
  });
}

function digestOutput(output: unknown): string {
  return createHash("sha256").update(stableStringify(output), "utf8").digest("hex");
}

function digestOutputMap(outputs: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) out[k] = digestOutput(v);
  return out;
}

function digestCompletion(payload: {
  workflowId: string;
  outcome: "completed" | "failed" | "cancelled";
  stepCount: number;
  stepOutputs: Record<string, string>;
}): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

function mergeDeps(override: Partial<WorkflowExecuteDeps> | undefined): WorkflowExecuteDeps {
  if (!override) return defaultDeps;
  return { ...defaultDeps, ...override };
}

void randomUUID;
