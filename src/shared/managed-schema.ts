/**
 * M3c.2 — managed-work IPC schemas.
 *
 * The two new IPC methods are `execute-verification` and
 * `record-review-decision`. Both flow over the existing
 * `ProtocolDispatcher`; the desktop's auto-forward loop in
 * `src/main/index.ts:124-137` picks up every key of `methods` and
 * pipes the call to the runtime, so all we need here is the
 * input/result Zod schemas.
 *
 * The schemas are deliberately permissive on the wire: the runtime
 * services re-validate via `verifyOnce`'s Zod parser and the
 * `reviews.ts` accept/reject path. We rely on `z.unknown().refine`
 * only at the seam — the inner service Zod schemas are the gate.
 */
import { z } from "zod";

/** Optional `commandOverride` for `execute-verification`. */
export const verificationOverrideSchema = z.object({
  command: z.string().trim().min(1).max(1024),
  argv: z.array(z.string().min(1).max(1024)).default([]),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
}).strict();

/**
 * Args: `[taskId, recipeId | null, override | null]`.
 * The renderer is the only legitimate caller today; the IPC layer
 * re-validates `recipeId` as a UUID when present.
 */
export const executeVerificationInputSchema = z.tuple([
  z.string().uuid(),
  z.string().uuid().nullable(),
  verificationOverrideSchema.nullable(),
]);

/**
 * Result union. `ok` carries the freshly minted `verificationId` and
 * `reviewId`; `conflict` carries the human-readable reason from the
 * executor (e.g. "task not found", "no workspace for task").
 */
export const executeVerificationResultSchema = z.union([
  z.object({
    kind: z.literal("ok"),
    verificationId: z.string().uuid(),
    reviewId: z.string().uuid(),
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);

/**
 * Args: `[reviewId, decision: "accept" | "reject", decidedBy]`.
 * Acceptance requires every evidence verification's required check
 * to be `passed`; rejection is always allowed on an open review.
 */
export const recordReviewDecisionInputSchema = z.tuple([
  z.string().uuid(),
  z.enum(["accept", "reject"]),
  z.string().min(1).max(256),
]);

export const recordReviewDecisionResultSchema = z.union([
  z.object({
    kind: z.literal("ok"),
    reviewId: z.string().uuid(),
    status: z.enum(["accepted", "rejected", "open", "invalidated"]),
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);

// M3c.3 — persistent attention inbox + bounded artifact previews.
//
// `transition-attention` is the single state-transition seam; the FSM
// widens `new → seen` for the snooze path but the renderer never has
// to call two methods. `snooze-attention` writes `snoozed_until` AND
// flips state atomically inside the runtime; we keep the two IPC
// methods separate so the wire shape mirrors the two-write nature of
// the change. `preview-artifact` is the gated read path; principal is
// required, scope is optional (overrides the persisted scope).

/** Args: `[attentionId, to: "seen" | "snoozed" | "dismissed" | "resolved"]`. */
export const transitionAttentionInputSchema = z.tuple([
  z.string().uuid(),
  z.enum(["seen", "snoozed", "dismissed", "resolved"]),
]);

/** Result: the updated attention item view. */
export const transitionAttentionResultSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  kind: z.enum(["decision", "conflict", "review", "stop"]),
  issueIdentity: z.string().min(1).max(256),
  revision: z.number().int().min(0).max(1024),
  state: z.enum(["new", "seen", "snoozed", "dismissed", "resolved"]),
  payloadJson: z.string().max(64 * 1024),
  snoozedUntil: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

/** Args: `[attentionId, until: ISO datetime]`. */
export const snoozeAttentionInputSchema = z.tuple([
  z.string().uuid(),
  z.string().datetime(),
]);

export const snoozeAttentionResultSchema = transitionAttentionResultSchema;

/**
 * Args: `[artifactId, principal, scopeJson | null]`.
 * `scopeJson` overrides the persisted grant scope (test-only today; the
 * M3c.4 diff/artifact view may use it for re-scope flows).
 */
export const previewArtifactInputSchema = z.tuple([
  z.string().uuid(),
  z.string().min(1).max(256),
  z.string().max(64 * 1024).nullable(),
]);

export const previewArtifactResultSchema = z.object({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncatedBase64Content: z.string().max(16 * 1024),
}).strict();

// M3c.4 — diff/artifact view.
//
// `render-candidate-diff` shells out to `git diff` inside the run's
// worktree (cap = 256 KiB; `since: "1.4.0"`). The renderer never sees
// `base`/`tree` separately from the projection — it passes the run id
// it already has from the `RunView`. `bytes` reports the *uncapped*
// captured length so the renderer can show "X MB / 256 KiB shown".

/** Args: `[runId]`. */
export const renderCandidateDiffInputSchema = z.tuple([
  z.string().uuid(),
]);

export const renderCandidateDiffResultSchema = z.object({
  runId: z.string().uuid(),
  base: z.string().regex(/^[0-9a-f]{7,64}$/),
  tree: z.string().regex(/^[0-9a-f]{7,64}$/),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  body: z.string().max(512 * 1024),
}).strict();
