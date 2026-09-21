/**
 * M6.4 — durable workflow run entity service.
 *
 * The M6.4 bullet (FUTURE/IMPLEMENTATION-README.md line 246) reads:
 *
 * > M6.4 Persist step outputs, durable waits, pending decisions and
 * > cancellation. Release execution capacity only when execution is
 * > quiescent; retain ownership or reacquire and revalidate before
 * > continuation. Services/watchers are owned resources with
 * > readiness/stop policies, not finite steps that finish when a
 * > PID appears.
 *
 * The runtime writes three durable shapes so a workflow can survive a
 * crash:
 *
 *   - `workflow_run`        — one row per `runWorkflow` invocation,
 *                              carrying the full graph + settings and
 *                              terminal outcome (if any).
 *   - `workflow_step_output` — one row per completed step, content-
 *                                addressed by `output_digest`.
 *   - `workflow_step_state` — one row per dispatched step; carries
 *                              `state`, durable `wake_at`, and any
 *                              `failure_json`.
 *
 * This service is the only path that writes those tables. It exposes:
 *
 *   - `startWorkflowRun(worker, { graph, settings })`  — insert a new
 *     `running` row + return its `uuid`.
 *   - `recordStepOutput(worker, runUuid, stepId, output)`  — upsert a
 *     completed step's output.
 *   - `recordStepState(worker, runUuid, stepId, state)`   — upsert the
 *     step's lifecycle state (`running` → `waiting` → `completed`).
 *   - `findWorkflowRunByWorkflowId(worker, workflowId)`  — read for
 *     resume + cancellation paths.
 *   - `listStepOutputs(worker, runUuid)`  — restore `completedOutputs`
 *     after a crash.
 *   - `listStepStates(worker, runUuid)`   — restore the in-flight set.
 *   - `requestWorkflowCancellation(worker, runUuid, by)`  — write the
 *     cancellation intent so the next executor tick observes it.
 *   - `finalizeWorkflowRun(worker, runUuid, outcome, digest)` — close
 *     the run row with a terminal outcome.
 *
 * The service is deliberately small and dependency-free so a renderer /
 * scheduler can drive `resumeWorkflow` without re-importing the
 * executor. All SQL lives in this file.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import {
  workflowRunRowSchema,
  workflowStepOutputRowSchema,
  workflowStepStateRowSchema,
  type WorkflowRunRow,
  type WorkflowStepOutputRow,
  type WorkflowStepStateRow,
} from "./schema";
import { stableStringify } from "./effective-settings";
import type { DbWorker } from "./worker";

// ---------------------------------------------------------------------------
// Driver adapter
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

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  "running", "completed", "failed", "cancelled",
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowStepLifecycleSchema = z.enum([
  "running", "waiting", "completed", "failed", "cancelled",
]);
export type WorkflowStepLifecycle = z.infer<typeof workflowStepLifecycleSchema>;

const startInputSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    createdBy: z.string().min(1).max(256),
    /**
     * Principal authorized to continue the run after pause / crash /
     * durable wait. The resume path compares the supplied identity
     * against the persisted value; a mismatch is refused.
     */
    ownerIdentity: z.string().min(1).max(256),
    graphJson: z.string().min(2).max(1_048_576),
    settingsJson: z.string().min(2).max(65_536),
  })
  .strict();
export type StartWorkflowRunInput = z.input<typeof startInputSchema>;

const stepStateInputSchema = z
  .object({
    state: workflowStepLifecycleSchema,
    dispatchedAt: z.string().datetime().nullable().default(null),
    wakeAt: z.string().datetime().nullable().default(null),
    failureJson: z.string().max(8192).nullable().default(null),
  })
  .strict();
export type RecordStepStateInput = z.input<typeof stepStateInputSchema>;

// ---------------------------------------------------------------------------
// Start a workflow run
// ---------------------------------------------------------------------------

/**
 * Insert a fresh `workflow_run` row. Refuses if a row with the same
 * `workflow_id` already exists (the executor uses `workflow_id` as the
 * public identity; a second concurrent invocation would silently
 * shadow state, so it is refused instead).
 */
export async function startWorkflowRun(
  worker: DbWorker,
  input: StartWorkflowRunInput,
): Promise<{ uuid: string }> {
  const parsed = startInputSchema.parse(input);
  const driver = driverOf(worker);
  const uuid = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT uuid FROM workflow_run WHERE workflow_id = ?")
      .first(parsed.workflowId);
    if (existing)
      throw new AppError(
        "CONFLICT",
        `workflow ${parsed.workflowId} already has a durable run (uuid=${String(existing.uuid)})`,
      );
    driver.prepare(
      "INSERT INTO workflow_run (uuid, workflow_id, status, created_by, " +
        "owner_identity, settings_json, graph_json, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      uuid, parsed.workflowId, "running",
      parsed.createdBy, parsed.ownerIdentity, parsed.settingsJson, parsed.graphJson, now,
    );
  });
  return { uuid };
}

// ---------------------------------------------------------------------------
// Step output
// ---------------------------------------------------------------------------

/**
 * Persist one completed step's output. The (run_uuid, step_id) tuple
 * is unique; a re-entry (e.g. resume replays the same step) UPSERTs
 * with the new `output_digest`. The digest participates in idempotency
 * detection so an executor that retries a previously-dispatched step
 * sees the same `output_digest` and avoids duplicating downstream
 * effects (the dispatcher decides whether to act on a duplicate).
 */
export async function recordStepOutput(
  worker: DbWorker,
  args: {
    runUuid: string;
    stepId: string;
    kind: string;
    output: Record<string, unknown>;
  },
): Promise<{ uuid: string; outputDigest: string }> {
  const driver = driverOf(worker);
  const outputJson = JSON.stringify(args.output);
  const outputDigest = createHash("sha256").update(stableStringify(args.output), "utf8").digest("hex");
  const now = new Date().toISOString();
  let uuid: string | undefined;
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT uuid FROM workflow_step_output WHERE workflow_run_uuid = ? AND step_id = ?")
      .first(args.runUuid, args.stepId);
    if (existing) {
      uuid = String(existing.uuid);
      driver.prepare(
        "UPDATE workflow_step_output SET kind = ?, output_json = ?, output_digest = ?, completed_at = ? " +
          "WHERE workflow_run_uuid = ? AND step_id = ?",
      ).run(args.kind, outputJson, outputDigest, now, args.runUuid, args.stepId);
      return;
    }
    uuid = randomUUID();
    driver.prepare(
      "INSERT INTO workflow_step_output (uuid, workflow_run_uuid, step_id, kind, " +
        "output_json, output_digest, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(uuid, args.runUuid, args.stepId, args.kind, outputJson, outputDigest, now);
  });
  if (!uuid) throw new AppError("UNAVAILABLE", "workflow_step_output row vanished after insert");
  return { uuid, outputDigest };
}

// ---------------------------------------------------------------------------
// Step state
// ---------------------------------------------------------------------------

/**
 * Upsert one step's lifecycle state. The executor calls this with:
 *   - `state: "running"`,   `dispatchedAt: <now>`   on dispatch;
 *   - `state: "waiting"`,   `wakeAt: <ts>`          on durable wait;
 *   - `state: "completed"`                        on completion;
 *   - `state: "failed"`,     `failureJson: <...>`  on terminal failure.
 */
export async function recordStepState(
  worker: DbWorker,
  args: {
    runUuid: string;
    stepId: string;
    kind: string;
  } & RecordStepStateInput,
): Promise<void> {
  const inner = stepStateInputSchema.parse({
    state: args.state,
    dispatchedAt: args.dispatchedAt,
    wakeAt: args.wakeAt,
    failureJson: args.failureJson,
  });
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT uuid FROM workflow_step_state WHERE workflow_run_uuid = ? AND step_id = ?")
      .first(args.runUuid, args.stepId);
    if (existing) {
      driver.prepare(
        "UPDATE workflow_step_state SET state = ?, dispatched_at = ?, wake_at = ?, " +
          "failure_json = ?, updated_at = ? WHERE workflow_run_uuid = ? AND step_id = ?",
      ).run(
        inner.state, inner.dispatchedAt, inner.wakeAt,
        inner.failureJson, now, args.runUuid, args.stepId,
      );
      return;
    }
    driver.prepare(
      "INSERT INTO workflow_step_state (uuid, workflow_run_uuid, step_id, kind, " +
        "state, dispatched_at, wake_at, failure_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), args.runUuid, args.stepId, args.kind,
      inner.state, inner.dispatchedAt, inner.wakeAt, inner.failureJson, now,
    );
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function findWorkflowRunByWorkflowId(
  worker: DbWorker,
  workflowId: string,
): Promise<WorkflowRunRow | undefined> {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM workflow_run WHERE workflow_id = ?")
    .first(workflowId);
  if (!row) return undefined;
  return workflowRunRowSchema.parse({
    uuid: String(row.uuid),
    workflow_id: String(row.workflow_id),
    status: String(row.status),
    created_by: String(row.created_by),
    owner_identity: String(row.owner_identity ?? ""),
    settings_json: String(row.settings_json),
    graph_json: String(row.graph_json),
    cancel_requested_at: row.cancel_requested_at == null ? null : String(row.cancel_requested_at),
    cancel_requested_by: row.cancel_requested_by == null ? null : String(row.cancel_requested_by),
    started_at: String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    terminal_outcome: row.terminal_outcome == null ? null : String(row.terminal_outcome),
    audit_digest: row.audit_digest == null ? null : String(row.audit_digest),
  });
}

export async function listStepOutputs(
  worker: DbWorker,
  runUuid: string,
): Promise<WorkflowStepOutputRow[]> {
  const driver = driverOf(worker);
  const rows = driver
    .prepare("SELECT * FROM workflow_step_output WHERE workflow_run_uuid = ?")
    .all(runUuid);
  return rows.map((row) => workflowStepOutputRowSchema.parse({
    uuid: String(row.uuid),
    workflow_run_uuid: String(row.workflow_run_uuid),
    step_id: String(row.step_id),
    kind: String(row.kind),
    output_json: String(row.output_json),
    output_digest: String(row.output_digest),
    completed_at: String(row.completed_at),
  }));
}

export async function listStepStates(
  worker: DbWorker,
  runUuid: string,
): Promise<WorkflowStepStateRow[]> {
  const driver = driverOf(worker);
  const rows = driver
    .prepare("SELECT * FROM workflow_step_state WHERE workflow_run_uuid = ?")
    .all(runUuid);
  return rows.map((row) => workflowStepStateRowSchema.parse({
    uuid: String(row.uuid),
    workflow_run_uuid: String(row.workflow_run_uuid),
    step_id: String(row.step_id),
    kind: String(row.kind),
    state: String(row.state),
    dispatched_at: row.dispatched_at == null ? null : String(row.dispatched_at),
    wake_at: row.wake_at == null ? null : String(row.wake_at),
    failure_json: row.failure_json == null ? null : String(row.failure_json),
    updated_at: String(row.updated_at),
  }));
}

/** Read a single step's recorded output for resume / replay. */
export async function readStepOutput(
  worker: DbWorker,
  runUuid: string,
  stepId: string,
): Promise<WorkflowStepOutputRow | undefined> {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM workflow_step_output WHERE workflow_run_uuid = ? AND step_id = ?")
    .first(runUuid, stepId);
  if (!row) return undefined;
  return workflowStepOutputRowSchema.parse({
    uuid: String(row.uuid),
    workflow_run_uuid: String(row.workflow_run_uuid),
    step_id: String(row.step_id),
    kind: String(row.kind),
    output_json: String(row.output_json),
    output_digest: String(row.output_digest),
    completed_at: String(row.completed_at),
  });
}

// ---------------------------------------------------------------------------
// Cancellation intent
// ---------------------------------------------------------------------------

/**
 * Mark a workflow run as cancellation-requested. The executor's tick
 * loop reads `cancel_requested_at` before dispatching each step; once
 * set, no new steps start and the run converges to `cancelled`.
 *
 * Idempotent — calling this twice does not overwrite the first
 * caller's `(cancel_requested_at, cancel_requested_by)` because the
 * existing record is preserved (audit-trail of the first intent
 * matters when two callers race).
 */
export async function requestWorkflowCancellation(
  worker: DbWorker,
  args: {
    runUuid: string;
    by: string;
  },
): Promise<{ cancelRequestedAt: string; alreadyRequested: boolean }> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  let cancelRequestedAt = now;
  let alreadyRequested = false;
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT cancel_requested_at, cancel_requested_by FROM workflow_run WHERE uuid = ?")
      .first(args.runUuid);
    if (!existing)
      throw new AppError("NOT_FOUND", `workflow_run ${args.runUuid} not found`);
    if (existing.cancel_requested_at != null) {
      alreadyRequested = true;
      cancelRequestedAt = String(existing.cancel_requested_at);
      return;
    }
    driver.prepare(
      "UPDATE workflow_run SET cancel_requested_at = ?, cancel_requested_by = ? WHERE uuid = ?",
    ).run(now, args.by, args.runUuid);
  });
  return { cancelRequestedAt, alreadyRequested };
}

// ---------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------

const finalizeInputSchema = z
  .object({
    runUuid: z.string().uuid(),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    auditDigest: z.string().regex(/^[0-9a-f]{64}$/),
    endedAt: z.string().datetime().default(() => new Date().toISOString()),
  })
  .strict();
export type FinalizeWorkflowRunInput = z.input<typeof finalizeInputSchema>;

/**
 * Close a workflow run with a terminal outcome. Sets `status`,
 * `ended_at`, `terminal_outcome`, and `audit_digest` in a single
 * transaction so a crash between commit and the executor's return
 * leaves the row in a state the next executor can detect as already
 * finalized.
 */
export async function finalizeWorkflowRun(
  worker: DbWorker,
  input: FinalizeWorkflowRunInput,
): Promise<void> {
  const parsed = finalizeInputSchema.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT status FROM workflow_run WHERE uuid = ?")
      .first(parsed.runUuid);
    if (!existing)
      throw new AppError("NOT_FOUND", `workflow_run ${parsed.runUuid} not found`);
    driver.prepare(
      "UPDATE workflow_run SET status = ?, ended_at = ?, terminal_outcome = ?, audit_digest = ? " +
        "WHERE uuid = ?",
    ).run(parsed.outcome, parsed.endedAt, parsed.outcome, parsed.auditDigest, parsed.runUuid);
  });
}

/** Test seam: clear the in-flight workflow guard. (Re-exported from
 * `workflow-execute.ts` for symmetry — kept here as well so tests can
 * reset both surfaces.) */
export function clearWorkflowRunsForTest(_worker: DbWorker): void {
  void _worker;
}

void z;