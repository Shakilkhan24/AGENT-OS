/**
 * M5.2 — lead-proposal admission schemas.
 *
 * The M5.2 lead proposes *bounded* work items and dependencies that
 * the runtime admits through the normal task + grant + admission path.
 * A proposal is a structured document: one or more `LeadWorkItem`s
 * plus a `dependencies` graph (`LeadDependency.from → LeadDependency.to`)
 * that the runtime validates for cycles / bounds / narrowness.
 *
 * The M5.2 trust model is **"child authority can only narrow"**:
 *
 *  - A child task's authority grants are a strict subset of the
 *    parent's approved grants (intersection of `scope_json` shapes,
 *    `expires_at ≤ parent.expires_at`, `depth = parent.depth + 1`,
 *    `allowance ≤ parent.allowance`).
 *  - Lead proposals must include at least the principal / project ids
 *    they want to manage. Proposals whose `requestedBy` is not the
 *    connection's bound principal are refused.
 *  - Active-run caps are enforced at admission: the runtime refuses
 *    a proposal (with `BUSY`) when the global cap (default 2) or
 *    the per-checkout writer cap (default 1) would be exceeded.
 *  - The runtime exposes project / provider / host limits via
 *    `readLeadAdmissionLimits()` so a renderer / CLI surface can
 *    show "X of Y slots used" without re-deriving them.
 *
 * Recipe requests and child-run spawning are deferred to a later
 * M5.2 increment; the present seam admits the *proposal + grants*
 * only.
 */
import { z } from "zod";

const principalSchema = z.string().trim().min(1).max(256);
const projectIdSchema = z.string().trim().min(1).max(256);

export const leadWorkItemSchema = z.object({
  /** Stable id within the proposal. The runtime generates the
   * task id; this `localId` is the caller's reference for
   * dependency wiring. */
  localId: z.string().trim().min(1).max(128),
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(8000).default(""),
  /** Provider / model / account-mode triple. All nullable —
   * the admit path may leave them set or fill in defaults. */
  providerVersion: z.string().min(1).max(256).nullable().optional(),
  model: z.string().min(1).max(256).nullable().optional(),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable().optional(),
  /** Optional identity commitments (base commit, root identity). */
  baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional(),
  rootIdentity: z.string().regex(/^\d+:\d+$/).nullable().optional(),
  /** Narrowing allowance — must be ≤ the parent's allowance
   * when submitted under an existing lead task. */
  allowance: z.number().int().min(1).max(1024).default(1),
}).strict();
export type LeadWorkItem = z.input<typeof leadWorkItemSchema>;

export const leadDependencySchema = z.object({
  from: z.string().trim().min(1).max(128),
  to: z.string().trim().min(1).max(128),
}).strict();
export type LeadDependency = z.input<typeof leadDependencySchema>;

export const leadAuthorityAssignmentSchema = z.object({
  /** localId of the work item this grant covers. */
  localId: z.string().trim().min(1).max(128),
  /** Identifier of a parent grant (UUID) the child grant must
   * narrow. Required for any grant with `kind: "authority"` —
   * the runtime refuses grants whose `kind === "authority"`
   * without a `parentGrantId`. */
  parentGrantId: z.string().uuid().nullable().default(null),
  scope: z.unknown().default({}),
  digests: z.record(z.string().max(80), z.string().regex(/^[0-9a-f]{64}$/)).default({}),
  restrictions: z.array(z.string().min(1).max(64)).default([]),
  /** Expiry must be ≤ the parent's expiresAt when narrowing. */
  expiresAt: z.string().datetime().nullable().default(null),
}).strict();
export type LeadAuthorityAssignment = z.input<typeof leadAuthorityAssignmentSchema>;

export const leadAdmissionContextSchema = z.object({
  principal: principalSchema,
  projectIds: z.array(projectIdSchema).min(1).max(64),
  /** Optional parent taskId; when set, all admitted child tasks
   * carry a `parent_task_id` lineage key in the meta table and
   * child grants must narrow against the parent's approved grants. */
  parentTaskId: z.string().uuid().nullable().default(null),
}).strict();
export type LeadAdmissionContext = z.input<typeof leadAdmissionContextSchema>;

export const leadWorkProposalSchema = z.object({
  context: leadAdmissionContextSchema,
  items: z.array(leadWorkItemSchema).min(1).max(64),
  dependencies: z.array(leadDependencySchema).max(256).default([]),
  grants: z.array(leadAuthorityAssignmentSchema).max(128).default([]),
}).strict();
export type LeadWorkProposal = z.input<typeof leadWorkProposalSchema>;

// ── Limits (exposed via `readLeadAdmissionLimits`) ────────────────────────────

export const leadAdmissionLimitsSchema = z.object({
  /** Hard ceiling on concurrently-running managed runs globally. */
  globalMaxActiveManagedRuns: z.number().int().min(1).max(64),
  /** Hard ceiling on managed writers per concrete checkout. */
  perCheckoutMaxActiveWriters: z.number().int().min(1).max(8),
  /** Per-project active-run caps (free-form map: projectId → max). */
  perProjectMaxActiveRuns: z.record(z.string().max(256), z.number().int().min(0).max(64)).default({}),
  /** Per-provider concurrent invocation caps (map: provider name → max). */
  perProviderMaxActiveInvocations: z.record(z.string().max(64), z.number().int().min(0).max(64)).default({}),
  /** Per-host active-run caps. */
  perHostMaxActiveRuns: z.record(z.string().max(128), z.number().int().min(0).max(64)).default({}),
}).strict();
export type LeadAdmissionLimits = z.infer<typeof leadAdmissionLimitsSchema>;

// ── Result envelopes ─────────────────────────────────────────────────────────

export const leadAdmitResultSchema = z.union([
  z.object({
    kind: z.literal("ok"),
    admittedItems: z.array(z.object({
      localId: z.string().trim().min(1).max(128),
      taskId: z.string().uuid(),
      projectId: z.string().max(256),
    })).max(64),
    admittedGrantIds: z.array(z.string().uuid()).max(128),
  }).strict(),
  z.object({
    kind: z.literal("conflict"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("busy"),
    reason: z.string().min(1).max(1024),
    /** Which limit tripped — the renderer surfaces the right
     * "N of M slots used" message. */
    trippedLimit: z.enum(["global-max-active-managed-runs",
      "per-checkout-writers", "per-project-active-runs",
      "per-provider-active-invocations", "per-host-active-runs"]),
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);
export type LeadAdmitResult = z.infer<typeof leadAdmitResultSchema>;

export const leadAdmissionStatusSchema = z.object({
  limits: leadAdmissionLimitsSchema,
  activeManagedRunsGlobally: z.number().int().min(0).max(1024),
  activeManagedRunsByProject: z.record(z.string().max(256), z.number().int().min(0).max(1024)),
  activeManagedRunsByHost: z.record(z.string().max(128), z.number().int().min(0).max(1024)),
  activeManagedInvocationsByProvider: z.record(z.string().max(64), z.number().int().min(0).max(1024)),
}).strict();
export type LeadAdmissionStatus = z.infer<typeof leadAdmissionStatusSchema>;
