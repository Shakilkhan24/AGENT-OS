/**
 * M5.4 — candidate integration + workspace promotion schemas.
 *
 * The M5.4 spec (FUTURE/IMPLEMENTATION-README.md line 232) reads:
 *
 * > M5.4 Integrate completed changes into a distinct candidate
 * > workspace. Serialize shared Git mutations, verify the combined
 * > result and recheck the target base at promotion. Use
 * > expected-old-ref operations where applicable, and never update a
 * > checked-out branch behind its files. Dirty work, submodules,
 * > LFS/filter behavior and shared ports/services need explicit
 * > support or visible refusal.
 *
 * The trust model:
 *
 *  - Each member task's candidate is materialised in its own
 *    worktree (M3a). M5.4 stitches N accepted candidate trees onto
 *    a fresh `targetBase` worktree via `git merge --no-ff` and
 *    re-verifies the combined result through the same `verifyOnce`
 *    machinery M3c.2 uses. Conflicts are surfaced verbatim; the
 *    runtime never auto-resolves them.
 *  - Shared Git mutations across the same `repoDir` are
 *    serialised through a per-`repoDir` mutex row in the existing
 *    `meta` table (`integration-git-lock:<repoDir>`). A second
 *    call against the same repo while the lock is held returns
 *    `kind: "busy"`. The lock TTL is
 *    `DEFAULT_INTEGRATION_LOCK_TTL_MS = 60_000` so a crashed
 *    holder self-evicts.
 *  - Promotion uses `git update-ref <ref> <newSha> <expectedOld>`
 *    as a CAS. When `git rev-parse <ref>` ≠ `expectedOld`, the
 *    promotion refuses `kind: "conflict"` with
 *    `reason: "expected-old-ref-mismatch"` — never silently
 *    fast-forwards, never uses `--force`, never shells out to
 *    `git push`.
 *  - A target branch that is currently checked out at some worktree
 *    path is promoted via `git -C <worktreePath> merge --ff-only`
 *    inside that worktree, AND only when `git status --porcelain`
 *    is empty. Diverged (non-fast-forward) promotions onto a
 *    checked-out branch refuse `kind: "conflict"` with
 *    `reason: "checked-out-branch"`.
 *  - Submodules are a hard refusal. LFS-tracked paths, smudge/clean
 *    filters outside the allowlist, and shared-service paths
 *    (systemd / init.d / LaunchDaemons / LaunchAgents / `services/`)
 *    are surfaced as `unsupportedReasons[]` warnings; the
 *    integration proceeds with the supported subset.
 *  - Every persisted record carries a SHA-256 `payloadDigest`
 *    computed over the canonical JSON payload (via
 *    `runtime/db/effective-settings.ts:stableStringify`). The
 *    digest excludes capture timestamps so identical re-observations
 *    produce identical digests (mirrors the M4.6 / M4.7 / M5.2
 *    content-addressed audit pattern).
 *
 * Storage convention (mirrors M4.6 / M4.7 / M5.2):
 *
 *  - `integration-plan:<integrationId>` → the immutable
 *    `IntegrationPlan` (excludes `createdAt`).
 *  - `integration-by-base:<targetBase>:<integrationId>` →
 *    inverse index from base → integration (audit-trail).
 *  - `integration-git-lock:<repoDir>` → the per-repo mutex
 *    (expires at `acquiredAt + DEFAULT_INTEGRATION_LOCK_TTL_MS`).
 *  - `integration-promotion:<integrationId>` → the `PromoteOk`
 *    row (excludes `promotedAt`).
 *  - `promotion-by-base:<expectedOldBase>:<integrationId>` →
 *    inverse index from base → promotion.
 *  - `integration-superseded:<integrationId>` → the supersession
 *    record for rollback.
 *
 * Renderer / IPC integration is deferred to a later M5 increment.
 */
import { z } from "zod";

const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

const integrationMemberSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid(),
  candidateBase: commitShaSchema,
  candidateTree: commitShaSchema,
  candidateDiff: z.string().regex(/^[0-9a-f]{64}$/),
  /** Composite of `(taskId, runId, candidateBase, candidateTree, candidateDiff)`. */
  memberRevision: z.string().regex(/^[0-9a-f]{64}$/),
  title: z.string().min(1).max(200),
}).strict();
export type IntegrationMember = z.input<typeof integrationMemberSchema>;

export const integrationUnsupportedReasonSchema = z.enum([
  "submodule",
  "lfs-path",
  "shared-service-path",
  "smudge-filter",
  "clean-filter",
  "checked-out-branch",
  "dirty-worktree",
  "expected-old-ref-mismatch",
]);
export type IntegrationUnsupportedReason = z.infer<typeof integrationUnsupportedReasonSchema>;

export const integrationPlanRequestSchema = z.object({
  taskIds: z.array(z.string().uuid()).min(1).max(16),
  repoDir: z.string().min(1).max(1024),
  targetBase: commitShaSchema,
  integrationWorktreePath: z.string().min(1).max(1024),
  recipeId: z.string().uuid().optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  argv: z.array(z.string().min(1).max(1024)).default([]),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
  /** ISO timestamp; the verifier's deadline. */
  deadlineAt: z.string().datetime(),
}).strict().refine(v => Boolean(v.recipeId) || Boolean(v.command), {
  message: "integration plan requires either recipeId or a command override",
});
export type IntegrationPlanRequest = z.input<typeof integrationPlanRequestSchema>;

export const integrationPlanSchema = z.object({
  integrationId: z.string().uuid(),
  targetBase: commitShaSchema,
  combinedTree: commitShaSchema,
  combinedDiff: z.string().regex(/^[0-9a-f]{64}$/),
  memberInputs: z.array(integrationMemberSchema).min(1).max(16),
  unsupportedReasons: z.array(integrationUnsupportedReasonSchema),
  createdAt: z.string().datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  verificationId: z.string().uuid().nullable(),
  reviewId: z.string().uuid().nullable(),
}).strict();
export type IntegrationPlan = z.infer<typeof integrationPlanSchema>;

export const promoteCandidateRequestSchema = z.object({
  integrationId: z.string().uuid(),
  targetBranch: z.string().regex(/^[A-Za-z0-9._\/-]{1,256}$/),
  expectedOldBase: commitShaSchema,
  decider: z.string().min(1).max(256),
}).strict();
export type PromoteCandidateRequest = z.input<typeof promoteCandidateRequestSchema>;

export const promoteCandidateResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    integrationId: z.string().uuid(),
    targetBranch: z.string().regex(/^[A-Za-z0-9._\/-]{1,256}$/),
    oldBase: commitShaSchema,
    newBase: commitShaSchema,
    mergedTree: commitShaSchema,
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
    promotedAt: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    reason: z.string().min(1).max(2048),
    offendingFiles: z.array(z.string().min(1).max(1024)).max(256),
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("not-found"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("busy"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);
export type PromoteCandidateResult = z.infer<typeof promoteCandidateResultSchema>;

export const gitLockRecordSchema = z.object({
  repoDir: z.string().min(1).max(1024),
  holder: z.string().min(1).max(256),
  acquiredAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type GitLockRecord = z.infer<typeof gitLockRecordSchema>;

export const rollbackIntegrationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ok"),
    integrationId: z.string().uuid(),
    supersededAt: z.string().datetime(),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("not-found"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);
export type RollbackIntegrationResult = z.infer<typeof rollbackIntegrationResultSchema>;
