/**
 * M6.4 — durable workflow execution.
 *
 * The M6.4 bullet (FUTURE/IMPLEMENTATION-README.md line 246) reads:
 *
 * > M6.4 Persist step outputs, durable waits, pending decisions and
 * > cancellation. Release execution capacity only when execution is
 * > quiescent; retain ownership or reacquire and revalidate before
 * > continuation.
 *
 * `runWorkflowDurable` is the durable counterpart of the inline
 * M6.1 executor. It runs the same primitive sequence (`agent` /
 * `command` / `check` / `approval` / `artifact` / `wait`) but writes
 * a durable trail so a crash mid-run can be recovered:
 *
 *   - On entry: insert a `workflow_run` row (status: `running`,
 *     settings + graph embedded as JSON for replay).
 *   - On each step dispatch: upsert `workflow_step_state` with
 *     `state: "running"`, `dispatched_at: <now>`.
 *   - On durable wait / approval poll: upsert with `state: "waiting"`,
 *     `wake_at: <ts>` so a later resume can `setTimeout(remaining)`.
 *   - On step completion: append `workflow_step_output` and set
 *     `state: "completed"`.
 *   - On terminal outcome: `finalizeWorkflowRun(...)` with the
 *     audit digest.
 *
 * `resumeWorkflow(workflowId)` reconstructs the in-memory state
 * `(completedOutputs, completedIds)` from the persisted rows and
 * re-runs the loop; already-completed steps are NOT re-dispatched.
 *
 * `cancelWorkflow(workflowId, by)` writes cancellation intent; the
 * executor observes it at the top of each tick.
 *
 * Capacity release semantics: only steps with `state === "running"`
 * count toward `inFlight`. `state === "waiting"` does NOT consume a
 * slot (per the M6.4 bullet "release execution capacity only when
 * execution is quiescent"); a `wake_at` lets the scheduler wake the
 * controller without the slot being held open.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import type { DbWorker } from "../db/worker";
import {
  resolveWorkflowExecutorSettings,
  type WorkflowExecutorSettings,
  type WorkflowExecutorSettingsInput,
  type WorkflowGraph,
  type WorkflowGraphInput,
  type WorkflowResult,
  type WorkflowStep,
  workflowGraphSchema,
  workflowResultSchema,
} from "../../shared/workflow-executor-schema";
import {
  resolveReadySteps,
  topologicalOrder,
  validateWorkflowGraph,
} from "../db/workflow-graph";
import {
  finalizeWorkflowRun,
  findWorkflowRunByWorkflowId,
  listStepOutputs,
  recordStepOutput,
  recordStepState,
  requestWorkflowCancellation,
  startWorkflowRun,
} from "../db/workflow-runs";
import {
  executeOnce,
  type ExecuteOnceInput,
  type ExecuteOnceResult,
} from "./execute-once";
import {
  verifyOnce,
  type VerifyOnceInput,
  type VerifyOnceResult,
} from "./verifier-execute";
import { pinArtifact, type PinArtifactInput } from "../db/artifact-references";
import { readReview } from "../db/reviews";
import { isStopped } from "./stop-policy";

// ---------------------------------------------------------------------------
// Re-use the same dependency surface as M6.1 so tests can swap primitives.
// ---------------------------------------------------------------------------

export interface WorkflowDurableDeps {
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
  /** M7.3 — monotonic clock. Returns integer ms since an arbitrary
   *  process-relative origin; must never decrease inside one
   *  process. Existing callers can stub it to `() => 0n` when the
   *  audit log does not care about monotonic ordering. */
  readonly monotonicNow?: () => bigint;
}

import { execFile as nodeExecFile } from "node:child_process";
import { promisify } from "node:util";

const defaultExecFile = promisify(nodeExecFile) as unknown as (
  bin: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer; code: number | null; signal: NodeJS.Signals | null }>;

const defaultDeps: WorkflowDurableDeps = {
  executeOnce,
  verifyOnce,
  pinArtifact: pinArtifact as unknown as WorkflowDurableDeps["pinArtifact"],
  readReview: readReview as unknown as WorkflowDurableDeps["readReview"],
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
  monotonicNow: () => process.hrtime.bigint() / 1_000_000n,
};

// ---------------------------------------------------------------------------
// In-flight guard (process-global, shared with M6.1).
// ---------------------------------------------------------------------------

const inFlightWorkflows = new Set<string>();

/** Test seam. */
export function inflightDurableWorkflowIds(): ReadonlyArray<string> {
  return [...inFlightWorkflows];
}

/** Test seam. */
export function resetDurableInflight(): void {
  inFlightWorkflows.clear();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface RunWorkflowDurableOptions {
  settings?: WorkflowExecutorSettingsInput | null;
  deps?: Partial<WorkflowDurableDeps>;
  /** Optional — defaults to `<now>`; used by tests for deterministic digests. */
  nowIso?: () => string;
  /**
   * The principal authorized to run / continue this workflow. On
   * `runWorkflowDurable` the value is persisted as `owner_identity`
   * on the `workflow_run` row; on `resumeWorkflow` the supplied
   * identity is compared against the persisted value, and a
   * mismatch is refused with `AppError("CONFLICT")` — the
   * "revalidate before continuation" gate from the M6.4 spec.
   */
  ownerIdentity?: string;
}

const RUN_WORKFLOW_DURABLE_INPUT = z
  .object({
    workflow: workflowGraphSchema,
    settings: z.unknown().nullable().default(null),
  })
  .strict();

/**
 * Durable counterpart of `runWorkflow`. Persists the run row before
 * dispatching any step; a crash mid-execution leaves the row in
 * `status: "running"` so `resumeWorkflow(workflowId)` can continue.
 *
 * Returns the same `WorkflowResult` envelope as M6.1. Throws
 * `AppError("INVALID_REQUEST")` for any pre-dispatch validation
 * failure; throws `AppError("CONFLICT")` if the workflowId already
 * has a durable row.
 */
export async function runWorkflowDurable(
  worker: DbWorker,
  input: { workflow: WorkflowGraphInput; settings?: WorkflowExecutorSettingsInput | null },
  options: RunWorkflowDurableOptions = {},
): Promise<WorkflowResult> {
  const parsed = RUN_WORKFLOW_DURABLE_INPUT.parse(input);
  const graph: WorkflowGraph = parsed.workflow;
  const settings = resolveWorkflowExecutorSettings(parsed.settings as WorkflowExecutorSettingsInput | null);
  const deps = mergeDeps(options.deps);
  const nowIso = options.nowIso ?? defaultDeps.nowIso;

  // Pre-dispatch graph validation — same gates as M6.1.
  validateWorkflowGraph(graph.steps, graph.edges);
  const ordered = topologicalOrder(graph.steps, graph.edges);

  // Capacity guard.
  if (inFlightWorkflows.has(graph.workflowId))
    throw new AppError("FORBIDDEN", "workflow.durable: recursive execution refused");
  inFlightWorkflows.add(graph.workflowId);

  const started = await startWorkflowRun(worker, {
    workflowId: graph.workflowId,
    createdBy: graph.createdBy,
    ownerIdentity: options.ownerIdentity ?? graph.createdBy,
    graphJson: JSON.stringify(graph),
    settingsJson: JSON.stringify(settings),
  });

  try {
    return await runDurableLoop(worker, graph, ordered, settings, deps, started.uuid, nowIso);
  } finally {
    inFlightWorkflows.delete(graph.workflowId);
  }
}

// ---------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------

/**
 * Resume a durable workflow that crashed mid-run. Reconstructs
 * `completedOutputs` from `workflow_step_output` and continues from
 * the next ready step. Returns the same `WorkflowResult` envelope.
 *
 * Before any step is dispatched, the supplied `ownerIdentity` (or
 * `graph.createdBy` fallback) is compared against the persisted
 * `owner_identity` row. A mismatch refuses the resume with
 * `AppError("CONFLICT")` — this is the "revalidate ownership
 * before continuation" gate from the M6.4 spec. A paused run whose
 * host has been transferred to a different principal cannot be
 * silently resumed.
 */
export async function resumeWorkflow(
  worker: DbWorker,
  workflowId: string,
  options: RunWorkflowDurableOptions = {},
): Promise<WorkflowResult> {
  const run = await findWorkflowRunByWorkflowId(worker, workflowId);
  if (!run) throw new AppError("NOT_FOUND", `No durable workflow run for ${workflowId}`);
  if (run.status !== "running")
    throw new AppError(
      "CONFLICT",
      `Workflow ${workflowId} already finalized with status ${run.status}`,
    );
  const graph = workflowGraphSchema.parse(JSON.parse(run.graph_json));
  // Revalidate ownership BEFORE reconstructing completed outputs and
  // re-entering the dispatch loop. The persisted owner is the
  // principal that started the run; the supplied identity is the
  // principal requesting continuation.
  const claimedOwner = options.ownerIdentity ?? graph.createdBy;
  if (run.owner_identity && run.owner_identity !== claimedOwner)
    throw new AppError(
      "CONFLICT",
      `Workflow ${workflowId} owner mismatch: persisted=${run.owner_identity}, requested=${claimedOwner}; refusing to continue without revalidation`,
    );
  const settings = resolveWorkflowExecutorSettings(JSON.parse(run.settings_json) as WorkflowExecutorSettingsInput | null);
  const deps = mergeDeps(options.deps);
  const nowIso = options.nowIso ?? defaultDeps.nowIso;

  validateWorkflowGraph(graph.steps, graph.edges);
  const ordered = topologicalOrder(graph.steps, graph.edges);

  if (inFlightWorkflows.has(graph.workflowId))
    throw new AppError("FORBIDDEN", "workflow.durable: recursive execution refused");
  inFlightWorkflows.add(graph.workflowId);

  try {
    // Restore completed outputs from the durable trail.
    const completedOutputs = await restoreOutputs(worker, run.uuid);
    const completedIds = new Set<string>(Object.keys(completedOutputs));
    return await runDurableLoop(worker, graph, ordered, settings, deps, run.uuid, nowIso, {
      completedOutputs,
      completedIds,
    });
  } finally {
    inFlightWorkflows.delete(graph.workflowId);
  }
}

async function restoreOutputs(worker: DbWorker, runUuid: string): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const row of await listStepOutputs(worker, runUuid)) {
    out[row.step_id] = JSON.parse(row.output_json) as unknown;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

const cancelInputSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    by: z.string().min(1).max(256),
  })
  .strict();

/**
 * Request cancellation of a durable workflow. The next tick observes
 * `cancel_requested_at` and converges the run to `cancelled`. Returns
 * the timestamp the intent was first written (idempotent — repeated
 * calls preserve the first caller's `by`).
 */
export async function cancelWorkflow(
  worker: DbWorker,
  input: { workflowId: string; by: string },
): Promise<{ cancelRequestedAt: string; alreadyRequested: boolean }> {
  const parsed = cancelInputSchema.parse(input);
  const run = await findWorkflowRunByWorkflowId(worker, parsed.workflowId);
  if (!run) throw new AppError("NOT_FOUND", `No durable workflow run for ${parsed.workflowId}`);
  if (run.status !== "running")
    throw new AppError(
      "CONFLICT",
      `Workflow ${parsed.workflowId} already finalized with status ${run.status}`,
    );
  return requestWorkflowCancellation(worker, { runUuid: run.uuid, by: parsed.by });
}

// ---------------------------------------------------------------------------
// Core loop
// ---------------------------------------------------------------------------

interface LoopState {
  completedOutputs: Record<string, unknown>;
  completedIds: Set<string>;
}

async function runDurableLoop(
  worker: DbWorker,
  graph: WorkflowGraph,
  ordered: ReadonlyArray<WorkflowStep>,
  settings: WorkflowExecutorSettings,
  deps: WorkflowDurableDeps,
  runUuid: string,
  nowIso: () => string,
  initial: LoopState = { completedOutputs: {}, completedIds: new Set<string>() },
): Promise<WorkflowResult> {
  const completedOutputs: Record<string, unknown> = { ...initial.completedOutputs };
  const completedIds = new Set<string>(initial.completedIds);
  let inFlight = 0;
  let failure: { code: string; message: string; stepId: string } | null = null;
  let cancelledStepId: string | null = null;

  // The remaining set must exclude any step whose durable state is
  // already `completed`. We start from the persisted state plus the
  // graph order so a resume picks up exactly the un-dispatched tail.
  const stepById = new Map<string, WorkflowStep>();
  for (const step of ordered) stepById.set(step.id, step);
  const remaining: WorkflowStep[] = ordered.filter((s) => !completedIds.has(s.id));

  while (remaining.length > 0) {
    // Cancellation intent — observed BEFORE pulling new work.
    const runRow = await findWorkflowRunByWorkflowId(worker, graph.workflowId);
    if (runRow?.cancel_requested_at) {
      cancelledStepId = findFirstUnfinished(remaining);
      break;
    }
    // Cancellation via isStopped on agent steps.
    const cancelledStep = findCancelledStep(remaining, completedIds);
    if (cancelledStep) {
      cancelledStepId = cancelledStep;
      break;
    }

    const ready = resolveReadySteps(remaining, completedIds);
    const slots = Math.max(0, settings.maxFanout - inFlight);
    const toDispatch = ready.slice(0, slots);
    if (toDispatch.length === 0) {
      // No ready steps. If we have a failure, exit; otherwise the
      // loop is stuck (shouldn't happen given the topo pre-check).
      if (failure) break;
      break;
    }
    inFlight += toDispatch.length;

    // Mark each step as `running` BEFORE the dispatch so a crash
    // during execution leaves a `running` row that resume can detect.
    for (const step of toDispatch) {
      await recordStepState(worker, {
        runUuid, stepId: step.id, kind: step.kind,
        state: "running", dispatchedAt: nowIso(), wakeAt: null, failureJson: null,
      });
    }

    const settled = await Promise.allSettled(
      toDispatch.map((step) => runDurableStep(worker, runUuid, step, completedOutputs, completedIds, settings, deps, nowIso)),
    );
    inFlight -= toDispatch.length;

    // Cancellation during a long-running step (e.g. wait, approval,
    // command timeout) — the wait steps block Promise.allSettled,
    // so we surface a cancellation observed mid-flight as a CANCELLED
    // throw with a synthetic output so the loop converges rather than
    // burning a 30s wait. The pollMs is small (≥50ms) so latency is
    // bounded.
    const cancelMidFlight = await pollForCancellation(worker, graph.workflowId, settings.waitPollMs);
    if (cancelMidFlight) {
      cancelledStepId = findFirstUnfinished(remaining);
      for (const step of toDispatch) {
        await recordStepState(worker, {
          runUuid, stepId: step.id, kind: step.kind,
          state: "cancelled", wakeAt: null,
          failureJson: JSON.stringify({ code: "CANCELLED", message: "workflow cancellation observed mid-flight" }),
        });
      }
      break;
    }

    for (let i = 0; i < settled.length; i++) {
      const step = toDispatch[i];
      const outcome = settled[i];
      if (outcome.status === "fulfilled") {
        const output = outcome.value;
        completedOutputs[step.id] = output;
        completedIds.add(step.id);
        const idx = remaining.findIndex((s) => s.id === step.id);
        if (idx >= 0) remaining.splice(idx, 1);
      } else {
        const error = outcome.reason;
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof AppError ? error.failure.code : "INTERNAL";
        if (!failure) failure = { code, message, stepId: step.id };
        const idx = remaining.findIndex((s) => s.id === step.id);
        if (idx >= 0) remaining.splice(idx, 1);
        await recordStepState(worker, {
          runUuid, stepId: step.id, kind: step.kind,
          state: "failed", wakeAt: null,
          failureJson: JSON.stringify({ code, message }),
        });
      }
    }
  }

  const now = nowIso();
  if (cancelledStepId !== null) {
    await finalizeWorkflowRun(worker, {
      runUuid, outcome: "cancelled",
      auditDigest: digestCompletion({ workflowId: graph.workflowId, outcome: "cancelled", stepCount: graph.steps.length, stepOutputs: digestOutputMap(completedOutputs) }),
      endedAt: now,
    });
    return workflowResultSchema.parse({
      kind: "cancelled",
      workflowId: graph.workflowId,
      stepOutputs: completedOutputs,
      auditDigest: digestCompletion({ workflowId: graph.workflowId, outcome: "cancelled", stepCount: graph.steps.length, stepOutputs: digestOutputMap(completedOutputs) }),
      cancelledAt: now,
      cancelledStepId,
    });
  }
  if (failure) {
    const digest = digestCompletion({ workflowId: graph.workflowId, outcome: "failed", stepCount: graph.steps.length, stepOutputs: digestOutputMap(completedOutputs) });
    await finalizeWorkflowRun(worker, { runUuid, outcome: "failed", auditDigest: digest, endedAt: now });
    return workflowResultSchema.parse({
      kind: "failed",
      workflowId: graph.workflowId,
      stepOutputs: completedOutputs,
      auditDigest: digest,
      failedAt: now,
      failedStepId: failure.stepId,
      failure: { code: failure.code, message: failure.message },
    });
  }
  const digest = digestCompletion({ workflowId: graph.workflowId, outcome: "completed", stepCount: graph.steps.length, stepOutputs: digestOutputMap(completedOutputs) });
  await finalizeWorkflowRun(worker, { runUuid, outcome: "completed", auditDigest: digest, endedAt: now });
  return workflowResultSchema.parse({
    kind: "completed",
    workflowId: graph.workflowId,
    stepOutputs: completedOutputs,
    auditDigest: digest,
    completedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Per-step dispatch (durable variants)
// ---------------------------------------------------------------------------

async function runDurableStep(
  worker: DbWorker,
  runUuid: string,
  step: WorkflowStep,
  completedOutputs: Record<string, unknown>,
  completedIds: Set<string>,
  settings: WorkflowExecutorSettings,
  deps: WorkflowDurableDeps,
  _nowIso: () => string,
): Promise<Record<string, unknown>> {
  // Resolve `inputRefs` into the step's `inputs` payload.
  const inputs = resolveInputRefs(step, completedOutputs, completedIds);

  switch (step.kind) {
    case "agent": {
      const s = step as Extract<WorkflowStep, { kind: "agent" }>;
      if (isStopped(s.runId))
        throw new AppError("CANCELLED", `run ${s.runId} is stopped; agent step refused`);
      const input: ExecuteOnceInput = {
        runId: s.runId,
        idempotencyKey: s.idempotencyKey,
        canonicalDigest: s.canonicalDigest,
        providerVersion: s.providerVersion,
        model: s.model,
        accountMode: s.accountMode,
        method: s.method,
        args: { ...(s.args as Record<string, unknown> ?? {}), ...inputs, prompt: s.prompt, attemptedBy: s.attemptedBy },
        scope: s.scope as Record<string, unknown> | undefined ?? {},
        deadlineAt: s.deadlineAt,
        parentInvocationId: s.parentInvocationId,
      };
      const result = await deps.executeOnce(worker, input);
      if (result.kind === "conflict") throw new AppError("CONFLICT", result.reason);
      if (result.kind === "ambiguous") throw new AppError("UNAVAILABLE", result.reason);
      const output = { invocationId: result.invocationId, dispatchIntentId: result.dispatchIntentId, rehydrated: result.rehydrated };
      await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "agent", output });
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "agent", state: "completed", wakeAt: null, failureJson: null });
      return output;
    }
    case "command": {
      const s = step as Extract<WorkflowStep, { kind: "command" }>;
      const bin = s.argv[0];
      const args = s.argv.slice(1);
      const result = await deps.execFile(bin, args, {
        cwd: s.cwd,
        env: s.env as Record<string, string>,
        timeout: s.timeoutMs ?? settings.defaultStepTimeoutMs,
        maxBuffer: Math.max(s.stdoutByteCap, s.stderrByteCap),
      });
      const stdout = result.stdout.slice(0, s.stdoutByteCap);
      const stderr = result.stderr.slice(0, s.stderrByteCap);
      if (result.code !== 0)
        throw new AppError("CONFLICT",
          `Command exited with code ${result.code}${result.signal ? ` (signal ${result.signal})` : ""}: ${stderr.slice(0, 1024)}`);
      const output = { stdout, stderr, exitCode: result.code, signal: result.signal };
      await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "command", output });
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "command", state: "completed", wakeAt: null, failureJson: null });
      return output;
    }
    case "check": {
      const s = step as Extract<WorkflowStep, { kind: "check" }>;
      const input: VerifyOnceInput = {
        taskId: s.taskId,
        runId: s.runId ?? undefined,
        recipeId: s.recipeId,
        command: s.command,
        argv: s.argv,
        env: {},
        deadlineAt: s.deadlineAt,
      };
      const result = await deps.verifyOnce(worker, input);
      if (result.kind === "conflict") throw new AppError("CONFLICT", result.reason);
      const output = { verificationId: result.verificationId, reviewId: result.reviewId, status: result.verification.status };
      await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "check", output });
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "check", state: "completed", wakeAt: null, failureJson: null });
      return output;
    }
    case "approval": {
      const s = step as Extract<WorkflowStep, { kind: "approval" }>;
      if (!s.reviewId)
        throw new AppError("INVALID_REQUEST", "approval step requires reviewId (attentionId-only path deferred)");
      const deadline = Date.now() + s.deadlineMs;
      // Persist `waiting` state with `wake_at` so a resume can pick up.
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "approval", state: "waiting", wakeAt: new Date(deadline).toISOString(), failureJson: null });
      while (Date.now() < deadline) {
        const review = await deps.readReview(worker, s.reviewId);
        if (!review)
          throw new AppError("NOT_FOUND", `Review ${s.reviewId} not found`);
        if (review.status === "accepted") {
          const output = { reviewId: s.reviewId, status: "accepted" };
          await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "approval", output });
          await recordStepState(worker, { runUuid, stepId: s.id, kind: "approval", state: "completed", wakeAt: null, failureJson: null });
          return output;
        }
        if (review.status === "rejected" || review.status === "invalidated")
          throw new AppError("CONFLICT", `Review ${s.reviewId} reached terminal state "${review.status}"; approval refused`);
        await waitForMs(deps, s.pollMs);
      }
      throw new AppError("TIMEOUT", `approval timed out after ${s.deadlineMs}ms waiting for review ${s.reviewId}`);
    }
    case "artifact": {
      const s = step as Extract<WorkflowStep, { kind: "artifact" }>;
      const pinned = await deps.pinArtifact(worker, {
        taskId: s.taskId,
        runId: s.runId,
        uri: s.uri,
        sha256: s.sha256,
        kind: s.artifactKind,
        bytes: s.bytes,
        mime: s.mime,
        expiresAt: s.expiresAt,
      });
      const output = { artifactId: pinned.id, sha256: pinned.sha256, kind: pinned.kind };
      await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "artifact", output });
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "artifact", state: "completed", wakeAt: null, failureJson: null });
      return output;
    }
    case "wait": {
      const s = step as Extract<WorkflowStep, { kind: "wait" }>;
      const ms = s.timeoutMs;
      // Persist the durable wake time. A crashed wait resumes from
      // `wake_at` minus `now()` on the next executor tick.
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "wait", state: "waiting", wakeAt: new Date(Date.now() + ms).toISOString(), failureJson: null });
      await waitForMs(deps, ms);
      const output = { waitedMs: ms };
      await recordStepOutput(worker, { runUuid, stepId: s.id, kind: "wait", output });
      await recordStepState(worker, { runUuid, stepId: s.id, kind: "wait", state: "completed", wakeAt: null, failureJson: null });
      return output;
    }
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
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
      throw new AppError("INVALID_REQUEST", `step ${step.id} inputRefs references ${ref.stepId} which has not completed`);
    const upstream = completedOutputs[ref.stepId];
    if (!upstream || typeof upstream !== "object")
      throw new AppError("INVALID_REQUEST", `step ${step.id} inputRefs references ${ref.stepId} which has no output map`);
    const value = (upstream as Record<string, unknown>)[ref.outputKey];
    inputs[ref.outputKey] = value;
  }
  return inputs;
}

function findCancelledStep(remaining: ReadonlyArray<WorkflowStep>, completedIds: Set<string>): string | null {
  for (const step of remaining) {
    if (step.kind !== "agent") continue;
    if (!completedIds.has(step.id) && isStopped(step.runId)) return step.id;
  }
  return null;
}

function findFirstUnfinished(remaining: ReadonlyArray<WorkflowStep>): string {
  // Used for cancellation: report the first remaining step's id so
  // the renderer can highlight where execution stopped.
  return remaining[0]?.id ?? "(none)";
}

function waitForMs(deps: WorkflowDurableDeps, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    deps.setTimeout(resolve, ms);
  });
}

/**
 * Poll the durable trail for `cancel_requested_at` for at most
 * `pollMs` milliseconds. Returns `true` as soon as the intent is
 * observed. The pollMs defaults to the executor's `waitPollMs`
 * setting so a slow step (e.g. 30s wait) does not delay cancellation
 * recognition beyond the configured cadence.
 */
async function pollForCancellation(
  worker: DbWorker,
  workflowId: string,
  pollMs: number,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < pollMs) {
    const row = await findWorkflowRunByWorkflowId(worker, workflowId);
    if (row?.cancel_requested_at) return true;
    await new Promise<void>((r) => setTimeout(r, Math.min(pollMs, 100)));
  }
  return false;
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

function mergeDeps(override: Partial<WorkflowDurableDeps> | undefined): WorkflowDurableDeps {
  if (!override) return defaultDeps;
  return { ...defaultDeps, ...override };
}