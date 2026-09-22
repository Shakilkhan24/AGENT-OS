/**
 * M3c.1 — managed-work view schemas for the renderer.
 *
 * The M3 entity schemas in `shared/managed.ts` describe the durable rows.
 * These `*View*` schemas describe what the renderer consumes. They flatten
 * the row shape (runId → taskId on the run view, payloadJson parsed on
 * attention items) into the form the UI needs while keeping the wire
 * shape backwards compatible with the M2 snapshot envelope.
 *
 * The projection is built once at the boundary in
 * `src/runtime/managed-projection.ts`. Renderer code never reaches into
 * the M3 DB; it consumes a single `ManagedProjection` value per snapshot.
 */
import { z } from "zod";
import { taskSchema, runSchema, invocationSchema, dispatchIntentSchema,
  leaseSchema, grantSchema, contextReceiptSchema,
  artifactReferenceSchema, attentionItemSchema,
  verificationRecipeSchema, verificationSchema, reviewSchema,
  taskStatusSchema, runStatusSchema, invocationStatusSchema,
  dispatchIntentStateSchema, leaseStateSchema, grantStateSchema,
  receiptStatusSchema, attentionStateSchema,
  verificationStatusSchema, reviewStatusSchema, reviewDecisionSchema } from "./managed";

/** Wire-shape view of a task for the read-only review shell. */
export const taskViewSchema = taskSchema.pick({
  id: true,
  title: true,
  objective: true,
  status: true,
  projectId: true,
  providerVersion: true,
  model: true,
  accountMode: true,
  hostId: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: taskStatusSchema,
});
export type TaskView = z.infer<typeof taskViewSchema>;

/** Wire-shape view of a run with task link for group rendering. */
export const runViewSchema = runSchema.pick({
  id: true,
  taskId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  baseRevision: true,
  terminalUuid: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: runStatusSchema,
  /** Count of invocations in the run (cheap aggregate; renderer doesn't need the IDs here). */
  invocationCount: z.number().int().min(0),
});
export type RunView = z.infer<typeof runViewSchema>;

/** Wire-shape view of an invocation. */
export const invocationViewSchema = invocationSchema.pick({
  id: true,
  runId: true,
  attempt: true,
  status: true,
  idempotencyKey: true,
  canonicalDigest: true,
  providerVersion: true,
  model: true,
  accountMode: true,
  startedAt: true,
  endedAt: true,
  endedReason: true,
  createdAt: true,
}).extend({
  status: invocationStatusSchema,
});
export type InvocationView = z.infer<typeof invocationViewSchema>;

/** Wire-shape view of a dispatch intent. */
export const dispatchIntentViewSchema = dispatchIntentSchema.pick({
  id: true,
  runId: true,
  invocationId: true,
  method: true,
  argsJson: true,
  scopeJson: true,
  deadlineAt: true,
  state: true,
  createdAt: true,
}).extend({
  state: dispatchIntentStateSchema,
});
export type DispatchIntentView = z.infer<typeof dispatchIntentViewSchema>;

/** Wire-shape view of a lease. */
export const leaseViewSchema = leaseSchema.pick({
  id: true,
  workspaceId: true,
  holder: true,
  state: true,
  acquiredAt: true,
  expiresAt: true,
  renewedAt: true,
  releasedAt: true,
  fencingToken: true,
}).extend({
  state: leaseStateSchema,
});
export type LeaseView = z.infer<typeof leaseViewSchema>;

/** Wire-shape view of a grant. */
export const grantViewSchema = grantSchema.pick({
  id: true,
  taskId: true,
  kind: true,
  scopeJson: true,
  principal: true,
  digestsJson: true,
  state: true,
  requestedAt: true,
  decidedAt: true,
  decidedBy: true,
}).extend({
  state: grantStateSchema,
});
export type GrantView = z.infer<typeof grantViewSchema>;

/** Wire-shape view of a context receipt. */
export const contextReceiptViewSchema = contextReceiptSchema.pick({
  id: true,
  runId: true,
  status: true,
  objective: true,
  digestsJson: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: receiptStatusSchema,
});
export type ContextReceiptView = z.infer<typeof contextReceiptViewSchema>;

/** Wire-shape view of an artifact reference. */
export const artifactReferenceViewSchema = artifactReferenceSchema.pick({
  id: true,
  taskId: true,
  runId: true,
  uri: true,
  sha256: true,
  kind: true,
  bytes: true,
  mime: true,
  importedAt: true,
  expiresAt: true,
});
export type ArtifactReferenceView = z.infer<typeof artifactReferenceViewSchema>;

/**
 * Wire-shape view of an attention item. M3c.3 surfaces `payloadJson`
 * (the renderer parses it lazily per `kind` inside `try/catch` and
 * renders escaped text) and `snoozedUntil` (so the badge can re-surface
 * items when the deadline passes).
 */
export const attentionItemViewSchema = attentionItemSchema.pick({
  id: true,
  taskId: true,
  kind: true,
  issueIdentity: true,
  revision: true,
  state: true,
  payloadJson: true,
  snoozedUntil: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  state: attentionStateSchema,
});
export type AttentionItemView = z.infer<typeof attentionItemViewSchema>;

/**
 * A single line in the structured, escaped run stream. The renderer is
 * allowed to paste this verbatim into a `<code>` block; the payload has
 * already passed schema validation server-side, so no HTML parsing is
 * needed and we keep `JSON.stringify` to escape control characters.
 */
export const runStreamEntrySchema = z.object({
  /** Database sequence — used for cursor-based incremental loads. */
  seq: z.number().int().nonnegative(),
  /** ISO timestamp recorded by the runtime when the event landed. */
  at: z.string().datetime(),
  /** Optional correlation id (usually the invocation id for provider events). */
  correlationId: z.string().min(1).max(256).nullable().default(null),
  /** Optional task scoping for cross-task timeline rendering. */
  taskId: z.string().uuid().nullable().default(null),
  /** Invocation id this entry belongs to. */
  invocationId: z.string().uuid().nullable().default(null),
  /** Event type — feeds the colour dot in the renderer. */
  type: z.enum([
    "provider.observation",
    "cursor.committed",
    "stop.requested",
    "dispatch.ambiguous",
    "execution.reconciled",
    "runtime.dispatched",
    "runtime.claimed",
    "runtime.spawned",
    "stop.escalated",
  ]),
  /** Pre-validated JSON-encoded payload; renderer does not parse this. */
  payloadJson: z.string().min(0).max(64 * 1024),
});
export type RunStreamEntry = z.infer<typeof runStreamEntrySchema>;

/**
 * Wire-shape view of a verification recipe (M3c.2). The recipe is
 * per-project configuration the renderer lists under the "Verifier"
 * section of `TaskDetail`. The `configurationRevision` is what a
 * `review` binds to — a recipe edit rotates the digest, and the next
 * `verifyOnce` opens a fresh review under the new revision.
 */
export const verificationRecipeViewSchema = verificationRecipeSchema.pick({
  id: true,
  projectId: true,
  name: true,
  command: true,
  argvJson: true,
  envJson: true,
  assertionPattern: true,
  required: true,
  configurationRevision: true,
  createdAt: true,
  updatedAt: true,
}).extend({});
export type VerificationRecipeView = z.infer<typeof verificationRecipeViewSchema>;

/**
 * Wire-shape view of a verification (M3c.2). One row per verifier run.
 * The renderer consumes the bounded stdout/stderr tails and the
 * `required_check_results_json` array under the "Verifier" section.
 */
export const verificationViewSchema = verificationSchema.pick({
  id: true,
  taskId: true,
  runId: true,
  recipeId: true,
  command: true,
  cwd: true,
  argvJson: true,
  envJson: true,
  configurationRevision: true,
  candidateBase: true,
  candidateTree: true,
  candidateDiff: true,
  status: true,
  exitCode: true,
  signal: true,
  startedAt: true,
  endedAt: true,
  assertionCountsJson: true,
  requiredCheckResultsJson: true,
  stdoutTailJson: true,
  stderrTailJson: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: verificationStatusSchema,
});
export type VerificationView = z.infer<typeof verificationViewSchema>;

/**
 * Wire-shape view of a review (M3c.2). The renderer consumes the
 * status badge + the candidate identity triple under the "Review"
 * section. `evidenceVerificationIdsJson` is a JSON-encoded array of
 * verification UUIDs the renderer can resolve against `verifications`.
 */
export const reviewViewSchema = reviewSchema.pick({
  id: true,
  taskId: true,
  runId: true,
  evidenceVerificationIdsJson: true,
  candidateBase: true,
  candidateTree: true,
  candidateDiff: true,
  configurationRevision: true,
  status: true,
  decision: true,
  decidedBy: true,
  decisionNote: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: reviewStatusSchema,
  decision: reviewDecisionSchema.nullable(),
});
export type ReviewView = z.infer<typeof reviewViewSchema>;

/**
 * Top-level wire shape returned by `buildManagedProjection(worker)`.
 *
 * - `available` is `false` when the projection cannot be built (DB not
 *   yet opened, schema-mismatch, in-memory driver opted out via env).
 *   The renderer falls back to its M2 surface in that case.
 * - `projectGroups` pre-groups tasks by `projectId` so the renderer
 *   doesn't loop twice.
 * - `taskIndex` is a flat lookup keyed by task id — the centre column
 *   uses it to render the detail pane without searching the list.
 * - `stream` is the *full* run-stream across all invocations, sorted by
 *   seq ASC. The renderer can slice by invocation locally; the payload
 *   size is bounded by the existing replay retention (see `settings`).
 */
export const managedProjectionSchema = z.object({
  available: z.literal(true),
  generatedAt: z.string().datetime(),
  /** Task list grouped by `projectId`; render order matches the input. */
  projectGroups: z.array(z.object({
    projectId: z.string(),
    tasks: z.array(taskViewSchema),
  })),
  /** Run views keyed by run id (uuid). */
  runs: z.array(runViewSchema),
  /** Invocation views. */
  invocations: z.array(invocationViewSchema),
  /** Dispatch intents. */
  dispatchIntents: z.array(dispatchIntentViewSchema),
  /** Lease rows (held / uncertain are interesting; released/expired stay for audit). */
  leases: z.array(leaseViewSchema),
  /** All grants (so reviewer can audit authority decisions). */
  grants: z.array(grantViewSchema),
  /** Context receipts (one per run; rejected receipts stay visible). */
  contextReceipts: z.array(contextReceiptViewSchema),
  /** Artifact references tied to a task or run. */
  artifacts: z.array(artifactReferenceViewSchema),
  /**
   * M3c.3 — open attention items driving the persistent inbox badge +
   * slide-in panel. "Open" = state ∈ {new, seen, snoozed} AND
   * (snoozedUntil IS NULL OR snoozedUntil <= generatedAt). The badge
   * count comes from this array's length.
   */
  openAttention: z.array(attentionItemViewSchema),
  /** Closed attention items (resolved/dismissed) for the per-task history pane. */
  closedAttention: z.array(attentionItemViewSchema),
  /** M3c.2 — verification recipes (per-project). */
  recipes: z.array(verificationRecipeViewSchema),
  /** M3c.2 — verification rows (one per verifier run, task-scoped). */
  verifications: z.array(verificationViewSchema),
  /** M3c.2 — review rows (the acceptance state machine). */
  reviews: z.array(reviewViewSchema),
  /** Persisted event rows for managed work, in seq order. */
  stream: z.array(runStreamEntrySchema),
});
export type ManagedProjection = z.infer<typeof managedProjectionSchema>;

export const managedProjectionUnavailableSchema = z.object({
  available: z.literal(false),
  reason: z.enum(["db-closed", "schema-mismatch", "degraded"]),
});
export type ManagedProjectionUnavailable = z.infer<typeof managedProjectionUnavailableSchema>;

export type ManagedProjectionOrUnavailable = ManagedProjection | ManagedProjectionUnavailable;
