/**
 * M3c.1 — read-only "managed" projection of M3a/M3b entities onto the
 * renderer's snapshot envelope.
 *
 * `buildManagedProjection(worker)` reads every entity row in a single
 * point-in-time pass. It returns `ManagedProjection` (the populated
 * wire shape) or an `{available: false, reason}` envelope when the
 * caller is in a degraded state (DB closed, schema mismatch).
 *
 * Consistency guarantees:
 *  - The full read walks a single `worker.exclusive` zone so a concurrent
 *    writer cannot interleave between the entity reads. We don't nest a
 *    transaction because a single read snapshot doesn't need
 *    all-or-nothing semantics; it only needs "no torn read across entities".
 *  - The structured run-stream is filtered to the event types that
 *    matter for review (see `MANAGED_STREAM_TYPES`). We deliberately
 *    exclude the M2 `terminal-*` lifecycle events — those already drive
 *    xterm — and the importer's `restore.*` audit events so a freshly
 *    restored backup doesn't flood the reviewer with replay history.
 *
 * The function is pure reading: it never mutates any row. That keeps it
 * cheap to call from `RuntimeWorkspace.snapshot()` without contending
 * with the orchestrator's writers.
 */
import type { DbWorker } from "./db/worker";
import { listTasks } from "./db/tasks";
import { listRunsForTask } from "./db/runs";
import { listInvocationsForRun } from "./db/invocations";
import { listDispatchIntentsForRun } from "./db/dispatch-intents";
import { listLeases } from "./db/leases";
import { listGrants } from "./db/grants";
import { listContextReceipts } from "./db/context-receipts";
import { listArtifacts } from "./db/artifact-references";
import { listAttention, listOpenAttention } from "./db/attention-items";
import { listRecipes } from "./db/verification-recipes";
import { listVerifications } from "./db/verifications";
import { listReviews } from "./db/reviews";
import { replaySince, takeSnapshot } from "./db/snapshot";
import { MANAGED_STREAM_TYPES, type RunStreamType } from "./managed-stream-types";
import {
  taskViewSchema,
  runViewSchema,
  invocationViewSchema,
  dispatchIntentViewSchema,
  leaseViewSchema,
  grantViewSchema,
  contextReceiptViewSchema,
  artifactReferenceViewSchema,
  attentionItemViewSchema,
  verificationRecipeViewSchema,
  verificationViewSchema,
  reviewViewSchema,
  runStreamEntrySchema,
  managedProjectionSchema,
  type ManagedProjection,
  type ManagedProjectionOrUnavailable,
} from "../shared/managed-view";
import type { Task, Run, Invocation, DispatchIntent, Lease, Grant, ContextReceipt, ArtifactReference, AttentionItem, VerificationRecipe, Verification, Review } from "../shared/managed";

/* ───────── projection (entity → wire view) ─────────────────────────────── */

function projectTaskView(task: Task) {
  return taskViewSchema.parse({
    id: task.id, title: task.title, objective: task.objective,
    status: task.status, projectId: task.projectId,
    providerVersion: task.providerVersion, model: task.model,
    accountMode: task.accountMode,
    hostId: task.hostId,
    createdAt: task.createdAt, updatedAt: task.updatedAt,
  });
}

function projectRunView(run: Run, invocationCount: number) {
  return runViewSchema.parse({
    id: run.id, taskId: run.taskId, status: run.status,
    startedAt: run.startedAt, endedAt: run.endedAt,
    baseRevision: run.baseRevision, terminalUuid: run.terminalUuid,
    createdAt: run.createdAt, updatedAt: run.updatedAt,
    invocationCount,
  });
}

function projectInvocationView(invocation: Invocation) {
  return invocationViewSchema.parse({
    id: invocation.id, runId: invocation.runId, attempt: invocation.attempt,
    status: invocation.status, idempotencyKey: invocation.idempotencyKey,
    canonicalDigest: invocation.canonicalDigest,
    providerVersion: invocation.providerVersion, model: invocation.model,
    accountMode: invocation.accountMode,
    startedAt: invocation.startedAt, endedAt: invocation.endedAt,
    endedReason: invocation.endedReason, createdAt: invocation.createdAt,
  });
}

function projectIntentView(intent: DispatchIntent) {
  return dispatchIntentViewSchema.parse({
    id: intent.id, runId: intent.runId, invocationId: intent.invocationId,
    method: intent.method, argsJson: intent.argsJson, scopeJson: intent.scopeJson,
    deadlineAt: intent.deadlineAt, state: intent.state, createdAt: intent.createdAt,
  });
}

function projectLeaseView(lease: Lease) {
  return leaseViewSchema.parse({
    id: lease.id, workspaceId: lease.workspaceId, holder: lease.holder,
    state: lease.state, acquiredAt: lease.acquiredAt, expiresAt: lease.expiresAt,
    renewedAt: lease.renewedAt, releasedAt: lease.releasedAt,
    fencingToken: lease.fencingToken,
  });
}

function projectGrantView(grant: Grant) {
  return grantViewSchema.parse({
    id: grant.id, taskId: grant.taskId, kind: grant.kind,
    scopeJson: grant.scopeJson, principal: grant.principal,
    digestsJson: grant.digestsJson, state: grant.state,
    requestedAt: grant.requestedAt, decidedAt: grant.decidedAt,
    decidedBy: grant.decidedBy,
  });
}

function projectReceiptView(receipt: ContextReceipt) {
  return contextReceiptViewSchema.parse({
    id: receipt.id, runId: receipt.runId, status: receipt.status,
    objective: receipt.objective, digestsJson: receipt.digestsJson,
    createdAt: receipt.createdAt, updatedAt: receipt.updatedAt,
  });
}

function projectArtifactView(artifact: ArtifactReference) {
  return artifactReferenceViewSchema.parse({
    id: artifact.id, taskId: artifact.taskId, runId: artifact.runId,
    uri: artifact.uri, sha256: artifact.sha256,
    bytes: artifact.bytes, mime: artifact.mime, kind: artifact.kind,
    importedAt: artifact.importedAt, expiresAt: artifact.expiresAt,
  });
}

function projectAttentionView(item: AttentionItem) {
  return attentionItemViewSchema.parse({
    id: item.id, taskId: item.taskId, kind: item.kind,
    issueIdentity: item.issueIdentity, revision: item.revision,
    state: item.state, payloadJson: item.payloadJson,
    snoozedUntil: item.snoozedUntil,
    createdAt: item.createdAt, updatedAt: item.updatedAt,
  });
}

function projectRecipeView(recipe: VerificationRecipe) {
  return verificationRecipeViewSchema.parse({
    id: recipe.id, projectId: recipe.projectId, name: recipe.name,
    command: recipe.command, argvJson: recipe.argvJson, envJson: recipe.envJson,
    assertionPattern: recipe.assertionPattern, required: recipe.required,
    configurationRevision: recipe.configurationRevision,
    createdAt: recipe.createdAt, updatedAt: recipe.updatedAt,
  });
}

function projectVerificationView(verification: Verification) {
  return verificationViewSchema.parse({
    id: verification.id, taskId: verification.taskId, runId: verification.runId,
    recipeId: verification.recipeId, command: verification.command, cwd: verification.cwd,
    argvJson: verification.argvJson, envJson: verification.envJson,
    configurationRevision: verification.configurationRevision,
    candidateBase: verification.candidateBase,
    candidateTree: verification.candidateTree,
    candidateDiff: verification.candidateDiff,
    status: verification.status, exitCode: verification.exitCode,
    signal: verification.signal, startedAt: verification.startedAt,
    endedAt: verification.endedAt,
    assertionCountsJson: verification.assertionCountsJson,
    requiredCheckResultsJson: verification.requiredCheckResultsJson,
    stdoutTailJson: verification.stdoutTailJson,
    stderrTailJson: verification.stderrTailJson,
    createdAt: verification.createdAt, updatedAt: verification.updatedAt,
  });
}

function projectReviewView(review: Review) {
  return reviewViewSchema.parse({
    id: review.id, taskId: review.taskId, runId: review.runId,
    evidenceVerificationIdsJson: review.evidenceVerificationIdsJson,
    candidateBase: review.candidateBase, candidateTree: review.candidateTree,
    candidateDiff: review.candidateDiff,
    configurationRevision: review.configurationRevision,
    status: review.status, decision: review.decision, decidedBy: review.decidedBy,
    decisionNote: review.decisionNote,
    createdAt: review.createdAt, updatedAt: review.updatedAt,
  });
}

/* ───────── structured run-stream ───────────────────────────────────────── */

function isManagedType(type: string): type is RunStreamType {
  return MANAGED_STREAM_TYPES.has(type as RunStreamType);
}

function projectEventRow(row: { seq: number; at: string; correlationId: string | null;
  originHookId: string | null; type: string; payloadJson: string }) {
  if (!isManagedType(row.type)) return undefined;
  const candidate = runStreamEntrySchema.safeParse({
    seq: row.seq,
    at: row.at,
    correlationId: row.correlationId ?? null,
    taskId: null, // resolved below via invocationId
    invocationId: row.correlationId ?? null, // orchestrator writes invocationId in correlation_id
    type: row.type,
    payloadJson: row.payloadJson,
  });
  return candidate.success ? candidate.data : undefined;
}

/** Drop entries that survived the schema gate but for which no task link exists. */
function dropOrphanInvocations<T extends { invocationId: string | null }>(
  entries: ReadonlyArray<T>,
  taskOfInvocation: ReadonlyMap<string, string>,
) {
  return entries.filter(entry => entry.invocationId == null || taskOfInvocation.has(entry.invocationId));
}

/* ───────── top-level entry point ───────────────────────────────────────── */

/**
 * Build the projection. `undefined` for `worker` (DB not opened yet) →
 * `{available: false, reason: "db-closed"}`. Any schema-mismatch in the
 * projection phase produces the same envelope with reason `schema-mismatch`.
 * The renderer handles both by falling back to the M2 surface.
 */
export async function buildManagedProjection(worker: DbWorker | undefined): Promise<ManagedProjectionOrUnavailable> {
  if (!worker) {
    return { available: false, reason: "db-closed" };
  }
  return worker.exclusive(async () => {
    // Schema-mismatch guard: a successful `takeSnapshot` confirms the meta
    // table is present (and the schema has been applied). Anything thrown
    // here falls through to `schema-mismatch`.
    try { await takeSnapshot(worker); }
    catch { return { available: false, reason: "schema-mismatch" }; }

    // Tasks, runs, invocations, intents. Walked task→run so we always
    // have a `taskOfInvocation` lookup without a second pass.
    const tasks = await listTasks(worker);
    const runs: Run[] = [];
    const invocations: Invocation[] = [];
    const intents: DispatchIntent[] = [];
    const taskOfInvocation = new Map<string, string>();
    for (const task of tasks) {
      const taskRuns = await listRunsForTask(worker, task.id);
      for (const run of taskRuns) {
        runs.push(run);
        const runInvocations = await listInvocationsForRun(worker, run.id);
        for (const invocation of runInvocations) {
          invocations.push(invocation);
          taskOfInvocation.set(invocation.id, run.taskId);
        }
        const runIntents = await listDispatchIntentsForRun(worker, run.id);
        intents.push(...runIntents);
      }
    }

    // Flat listers — the projection never relies on a parent row.
    const leases = await listLeases(worker);
    const grants = await listGrants(worker);
    const receipts = await listContextReceipts(worker);
    const artifacts = await listArtifacts(worker);
    // M3c.2 — verifier executor + review slices.
    const recipes = await listRecipes(worker);
    const verifications = await listVerifications(worker);
    const reviews = await listReviews(worker);

    // Attention — M3c.3 split into open (drives the inbox badge + panel)
    // and closed (per-task history). `listOpenAttention` already filters
    // by `{new, seen, snoozed}` AND `snoozedUntil` past its deadline;
    // `listAttention` is read fresh here so the two slices are derived
    // from the same point-in-time walk.
    const allAttention = await listAttention(worker);
    const openAttention = await listOpenAttention(worker);
    const closedAttention = allAttention.filter(item =>
      item.state === "resolved" || item.state === "dismissed",
    );

    // Stream — `replaySince(0)` reads every event with seq > 0, sorted.
    const replay = await replaySince(worker, 0);
    const filtered = replay.events
      .map(event => projectEventRow({
        seq: event.seq, at: event.at,
        correlationId: event.correlationId ?? null,
        originHookId: event.originHookId ?? null,
        type: event.type,
        payloadJson: JSON.stringify(event.data),
      }))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
    const linked = dropOrphanInvocations(filtered, taskOfInvocation);

    // Per-run invocation counts. Runs with zero invocations stay at 0
    // (no entry in the map) so the renderer sees them in the detail
    // list even when they have no provider activity yet.
    const invocationCountByRun = new Map<string, number>();
    for (const invocation of invocations) {
      invocationCountByRun.set(invocation.runId, (invocationCountByRun.get(invocation.runId) ?? 0) + 1);
    }
    for (const run of runs) if (!invocationCountByRun.has(run.id)) invocationCountByRun.set(run.id, 0);

    // Pre-group tasks by `projectId`; render order matches the input
    // projection (alphabetical id) for predictability.
    const projectGroupsMap = new Map<string, ReturnType<typeof projectTaskView>[]>();
    for (const task of tasks) {
      const view = projectTaskView(task);
      const list = projectGroupsMap.get(view.projectId) ?? [];
      list.push(view);
      projectGroupsMap.set(view.projectId, list);
    }
    const projectGroups = [...projectGroupsMap.entries()]
      .map(([projectId, list]) => ({ projectId, tasks: list }))
      .sort((left, right) => left.projectId.localeCompare(right.projectId));

    const projection: ManagedProjection = managedProjectionSchema.parse({
      available: true,
      generatedAt: new Date().toISOString(),
      projectGroups,
      runs: runs.map(run => projectRunView(run, invocationCountByRun.get(run.id) ?? 0)),
      invocations: invocations.map(projectInvocationView),
      dispatchIntents: intents.map(projectIntentView),
      leases: leases.map(projectLeaseView),
      grants: grants.map(projectGrantView),
      contextReceipts: receipts.map(projectReceiptView),
      artifacts: artifacts.map(projectArtifactView),
      openAttention: openAttention.map(projectAttentionView),
      closedAttention: closedAttention.map(projectAttentionView),
      recipes: recipes.map(projectRecipeView),
      verifications: verifications.map(projectVerificationView),
      reviews: reviews.map(projectReviewView),
      stream: linked,
    });
    return projection;
  });
}


