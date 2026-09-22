/**
 * M3a — Managed-work entity schemas.
 *
 * Eight entity families for the M3 "manage one repair" arc:
 *  - `task` — durable unit of work the user wants done;
 *  - `run` — one execution of a task (a task can exist without any run);
 *  - `invocation` — one provider round-trip inside a run (with idempotency);
 *  - `dispatch_intent` — one typed method invocation recorded before the
 *    runtime commits to a backend claim;
 *  - `workspace` — the working directory (a Git worktree or a recoverable
 *    snapshot) bound to a task;
 *  - `grant` — a typed authority a principal asks for; never self-approved;
 *  - `artifact_reference` — content-addressed pin of an external resource
 *    the receipt references;
 *  - `attention_item` — reviewable issue a renderer must surface.
 *
 * Identity fields (`providerVersion`, `model`, `accountMode`, `hostId`,
 * `baseIdentity`, `rootIdentity`) are recorded on every entity that crosses
 * the runtime/provider boundary so a reconnecting peer can prove its identity.
 *
 * The shared schemas here are the public shape (what callers see). The DB
 * row schemas in `runtime/db/schema.ts` extend these with the row's id +
 * timestamps; service modules re-parse row reads through the row schemas so
 * a future migration that adds a column is a single Zod change.
 */
import { z } from "zod";

// ── Common identity fragments ───────────────────────────────────────────────

/** UUID v4 — every entity id uses a bare UUID, no prefixes. */
const idSchema = z.string().uuid();

/** ISO-8601 timestamp (the `meta.generation` checkpoint uses the same shape). */
const timestampSchema = z.string().datetime();

/** Free-text identity, max 256 chars (provider version, model, account mode …). */
const identityStringSchema = z.string().trim().min(1).max(256);

/** Stable host id — opaque to callers but bounded. */
const hostIdSchema = z.string().min(1).max(128);

/** Git base identity (commit SHA), 7 to 64 lowercase hex chars. */
const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/** Filesystem root identity (dev:ino). */
const rootIdentitySchema = z.string().regex(/^\d+:\d+$/);

/** Provider-derived identity triple — every cross-boundary event carries it. */
export const providerIdentitySchema = z.object({
  providerVersion: identityStringSchema,
  model: identityStringSchema,
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
}).strict();
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

// ── Task ─────────────────────────────────────────────────────────────────────

export const taskStatusSchema = z.enum(["draft", "ready", "active", "done", "abandoned"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

// ── Lease ────────────────────────────────────────────────────────────────────

export const leaseStateSchema = z.enum(["held", "released", "uncertain", "expired"]);
export type LeaseState = z.infer<typeof leaseStateSchema>;

/**
 * A managed write lease. A lease pins a workspace to a single writer (a
 * controller process) for a bounded window so two writers cannot edit the
 * same checkout concurrently. The lease service is the only authority
 * that releases a held lease; a crashed controller leaves the lease
 * `held` until a `markUncertain` call surfaces the unknown state.
 */
export const leaseSchema = z.object({
  id: idSchema,
  workspaceId: idSchema,
  holder: z.string().min(1).max(256),
  state: leaseStateSchema,
  acquiredAt: timestampSchema,
  expiresAt: timestampSchema,
  renewedAt: timestampSchema.nullable(),
  releasedAt: timestampSchema.nullable(),
  fencingToken: z.number().int().min(0),
}).strict();
export type Lease = z.infer<typeof leaseSchema>;

// ── ContextReceipt ───────────────────────────────────────────────────────────

export const receiptStatusSchema = z.enum(["draft", "assembled", "submitted", "confirmed", "rejected"]);
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;

/**
 * A bounded context receipt for one managed run. It records the
 * objective, the selected revisions/hashes, the provider identity, the
 * environment and capabilities, and explicit exclusions. The status
 * state machine moves draft → assembled → submitted → confirmed | rejected.
 */
export const contextReceiptSchema = z.object({
  id: idSchema,
  runId: idSchema,
  status: receiptStatusSchema,
  objective: z.string().max(8000),
  constraintsJson: z.string().max(64 * 1024),
  acceptanceChecksJson: z.string().max(64 * 1024),
  selectedRevisionsJson: z.string().max(64 * 1024),
  instructionsJson: z.string().max(64 * 1024),
  environmentJson: z.string().max(64 * 1024),
  capabilitiesJson: z.string().max(64 * 1024),
  exclusionsJson: z.string().max(64 * 1024),
  digestsJson: z.string().max(64 * 1024),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type ContextReceipt = z.infer<typeof contextReceiptSchema>;

// ── Task ─────────────────────────────────────────────────────────────────────
export const taskSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(8000),
  status: taskStatusSchema,
  projectId: z.string().max(256),
  providerVersion: identityStringSchema.nullable(),
  model: identityStringSchema.nullable(),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable(),
  hostId: hostIdSchema,
  baseIdentity: commitShaSchema.nullable(),
  rootIdentity: rootIdentitySchema.nullable(),
  effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Task = z.infer<typeof taskSchema>;

// ── Run ──────────────────────────────────────────────────────────────────────

export const runStatusSchema = z.enum(["queued", "running", "completed", "cancelled", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  status: runStatusSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  baseRevision: commitShaSchema.nullable(),
  terminalUuid: z.string().uuid().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Run = z.infer<typeof runSchema>;

// ── Invocation ───────────────────────────────────────────────────────────────

export const invocationStatusSchema = z.enum(["pending", "admitted", "spawned", "observing", "done", "error"]);
export type InvocationStatus = z.infer<typeof invocationStatusSchema>;

export const invocationSchema = z.object({
  id: idSchema,
  runId: idSchema,
  attempt: z.number().int().min(1).max(1024),
  status: invocationStatusSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: identityStringSchema,
  model: identityStringSchema,
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  endedReason: z.string().min(1).max(256).nullable().default(null),
  createdAt: timestampSchema,
}).strict();
export type Invocation = z.infer<typeof invocationSchema>;

// ── DispatchIntent ───────────────────────────────────────────────────────────

export const dispatchIntentStateSchema = z.enum(["recorded", "claimed", "spawned", "acked", "expired"]);
export type DispatchIntentState = z.infer<typeof dispatchIntentStateSchema>;

export const dispatchIntentSchema = z.object({
  id: idSchema,
  runId: idSchema,
  invocationId: idSchema.nullable(),
  method: z.string().min(1).max(128),
  argsJson: z.string().max(64 * 1024),
  scopeJson: z.string().max(64 * 1024),
  deadlineAt: timestampSchema,
  state: dispatchIntentStateSchema,
  createdAt: timestampSchema,
}).strict();
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;

// ── Workspace ────────────────────────────────────────────────────────────────

export const workspaceKindSchema = z.enum(["git-worktree", "snapshot"]);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export const workspaceSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  kind: workspaceKindSchema,
  location: z.string().min(1).max(1024),
  baseIdentity: commitShaSchema.nullable(),
  worktreePath: z.string().min(1).max(1024).nullable(),
  headRevision: commitShaSchema.nullable(),
  leaseId: z.string().uuid().nullable(),
  createdAt: timestampSchema,
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;

// ── Grant ────────────────────────────────────────────────────────────────────

export const grantKindSchema = z.enum(["capability", "authority"]);
export type GrantKind = z.infer<typeof grantKindSchema>;

export const grantStateSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type GrantState = z.infer<typeof grantStateSchema>;

export const grantSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  kind: grantKindSchema,
  scopeJson: z.string().max(64 * 1024),
  principal: z.string().min(1).max(256),
  digestsJson: z.string().max(64 * 1024),
  state: grantStateSchema,
  requestedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  decidedBy: z.string().min(1).max(256).nullable(),
}).strict();
export type Grant = z.infer<typeof grantSchema>;

// ── ArtifactReference ────────────────────────────────────────────────────────

// M7.6 — `ci` joins the existing four kinds for read-only CI
// failure/log collection + release/deployment-plan artifacts. The
// kind is gated through the same `grant.scope_json.artifactKinds`
// authority check as the other four; no signing column is added
// (the M7.6 spec rejects that as scope creep).
export const artifactKindSchema = z.enum(["input", "context", "evidence", "output", "ci"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactReferenceSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  runId: idSchema.nullable(),
  uri: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: artifactKindSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(256),
  importedAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
}).strict();
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

// ── AttentionItem ────────────────────────────────────────────────────────────

// M7.7 — `schedule-decision` + `ci-failure` join the existing five
// attention kinds. Both reuse the existing FSM (`new | seen |
// snoozed | dismissed | resolved`); only the payload shape + the
// issueIdentity hashing (for stable-key dedup) differ.
export const attentionKindSchema = z.enum([
  "decision",
  "conflict",
  "review",
  "stop",
  "hook-failure",
  "schedule-decision",
  "ci-failure",
]);
export type AttentionKind = z.infer<typeof attentionKindSchema>;

export const attentionStateSchema = z.enum(["new", "seen", "snoozed", "dismissed", "resolved"]);
export type AttentionState = z.infer<typeof attentionStateSchema>;

export const attentionItemSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  kind: attentionKindSchema,
  issueIdentity: z.string().min(1).max(256),
  revision: z.number().int().min(0).max(1024),
  state: attentionStateSchema,
  payloadJson: z.string().max(64 * 1024),
  snoozedUntil: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type AttentionItem = z.infer<typeof attentionItemSchema>;

// ── VerificationRecipe (M3c.2) ──────────────────────────────────────────────

export const verificationStatusSchema = z.enum(["running", "passed", "failed", "error"]);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

/**
 * A verification recipe is a per-project configured command the
 * runtime can spawn against a run's candidate. Recipes live per
 * project (so a project's checks can be reused across its tasks);
 * the SHA-256 `configurationRevision` is the binding key a review
 * carries forward — when the recipe configuration changes, any
 * open review is invalidated.
 */
export const verificationRecipeSchema = z.object({
  id: idSchema,
  projectId: z.string().max(256),
  name: z.string().min(1).max(256),
  command: z.string().min(1).max(1024),
  argvJson: z.string().max(8 * 1024),
  envJson: z.string().max(8 * 1024),
  assertionPattern: z.string().max(1024).nullable(),
  required: z.boolean(),
  configurationRevision: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type VerificationRecipe = z.infer<typeof verificationRecipeSchema>;

/**
 * One verifier run. The `candidateBase`/`candidateTree`/`candidateDiff`
 * triple is the candidate identity the bound review records. The
 * `configurationRevision` is the recipe's binding key at spawn time
 * (a recipe revision change after the verification completes
 * invalidates the review).
 */
export const verificationSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  runId: idSchema.nullable(),
  recipeId: idSchema.nullable(),
  command: z.string().min(1).max(1024),
  cwd: z.string().min(1).max(4096),
  argvJson: z.string().max(8 * 1024),
  envJson: z.string().max(8 * 1024),
  configurationRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  candidateBase: commitShaSchema.nullable(),
  candidateTree: commitShaSchema.nullable(),
  candidateDiff: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  status: verificationStatusSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().min(1).max(64).nullable(),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  assertionCountsJson: z.string().max(8 * 1024).nullable(),
  requiredCheckResultsJson: z.string().max(64 * 1024),
  stdoutTailJson: z.string().max(64 * 1024),
  stderrTailJson: z.string().max(64 * 1024),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Verification = z.infer<typeof verificationSchema>;

// ── Review (M3c.2) ──────────────────────────────────────────────────────────

export const reviewStatusSchema = z.enum(["open", "accepted", "rejected", "invalidated"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewDecisionSchema = z.enum(["accepted", "rejected"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * The acceptance state machine bound to (candidate identity triple,
 * configuration revision, evidence verification ids). The acceptance
 * gate (`acceptReview`) refuses unless every required check on every
 * backing verification is `passed`.
 */
export const reviewSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  runId: idSchema.nullable(),
  evidenceVerificationIdsJson: z.string().max(64 * 1024),
  candidateBase: commitShaSchema.nullable(),
  candidateTree: commitShaSchema.nullable(),
  candidateDiff: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  configurationRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  status: reviewStatusSchema,
  decision: reviewDecisionSchema.nullable(),
  decidedBy: z.string().min(1).max(256).nullable(),
  decisionNote: z.string().max(8 * 1024).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Review = z.infer<typeof reviewSchema>;
