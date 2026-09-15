/**
 * M5.3 — per-layer dispatch policy + native-child observation schemas.
 *
 * The M5.3 spec (FUTURE/IMPLEMENTATION-README.md line 232) reads:
 *
 * > M5.3 Choose one dispatcher at each layer. Use native subagents for
 * > supported internal work; use managed child runs for separate
 * > providers/workspaces/hosts. Count observable native children and
 * > disclose observation gaps. Disable ungovernable native delegation
 * > where a hard budget is required; prompts cannot enforce process
 * > quotas.
 *
 * The trust model:
 *
 *  - "Native subagent" = a child spawned by the same provider
 *    instance, in the same workspace, on the same host, as its
 *    parent invocation. Anything else — different provider,
 *    different workspace, different host — requires a *managed*
 *    child run (one that goes through the same task + grant +
 *    admission path the M3 / M5.2 path already uses).
 *  - The runtime NEVER trusts a provider-supplied child count for
 *    cap enforcement when the provider cannot offer a verifiable
 *    OS-level pid + pgid. The capability matrix's
 *    `nativeSubagentSupport.defaultObservation` field carries the
 *    observation level the dispatcher reads.
 *  - When the caller (orchestrator, future CI / schedule
 *    admission, M7 schedule gate) flags `hardBudgetRequired:
 *    true`, the dispatcher MUST refuse to pick the native-subagent
 *    path when the provider's `defaultObservation` is in
 *    `hardBudgetRequiredObservationLevels` (default:
 *    `unobservable`, `provider-internal`). The returned
 *    `DispatchDecision` carries `kind: "forbidden"` +
 *    `trippedPolicy` so a caller can branch on the precise reason.
 *  - Every persisted record carries a SHA-256 `payloadDigest`
 *    computed over the canonical JSON payload (via
 *    `runtime/db/effective-settings.ts:stableStringify`). The
 *    digest excludes capture timestamps so identical re-observations
 *    produce identical digests (mirrors the M4.6 / M4.7 / M5.2
 *    content-addressed audit pattern).
 *
 * Storage convention (mirrors M4.6 / M4.7 / M5.2):
 *
 *  - `native-child-pid:<invocationId>:<seq>` → records pid +
 *    provider + observation + payloadDigest.
 *  - `native-child-pgid:<invocationId>:<seq>` → records pgid +
 *    provider + payloadDigest (only when the runner captured a
 *    pgid; absent otherwise).
 *
 * Renderer / IPC integration is deferred to a later M5 increment.
 */
import { z } from "zod";

// ── Observation levels ───────────────────────────────────────────────────────

/**
 * The four observation levels a native-child capture can land in.
 *
 *  - `fully-observed` — we directly observed the child's pid AND
 *    (when present) its pgid in the OS process table. This is the
 *    only level that satisfies a hard cap; the runtime can
 *    actually count live children.
 *  - `pid-only` — we observed the pid only (no pgid available,
 *    typically because the provider's binary does not expose its
 *    process group). The runtime reports the pid count but cannot
 *    guarantee the child has not forked off grandchildren of its
 *    own; counts are advisory.
 *  - `unobservable` — the provider declares it spawned a child
 *    but gives us no pid we can verify — we cannot count it. The
 *    runtime surfaces the count in
 *    `delegationStatusSchema.unobservedChildrenByLevel` so a
 *    renderer can show "≥ N unobservable native children"
 *    without making up a count.
 *  - `provider-internal` — the child is itself another managed
 *    provider invocation (a sub-invocation), not an OS-level
 *    subagent of the current run. The pid is the managed child's,
 *    not a sub-shell of our own.
 */
export const nativeChildObservationLevelSchema = z.enum([
  "fully-observed",
  "pid-only",
  "unobservable",
  "provider-internal",
]);
export type NativeChildObservationLevel = z.infer<typeof nativeChildObservationLevelSchema>;

/**
 * What the runner reports at observation time. Maps to the
 * `level` enum via `observationFromEvent`.
 */
export const nativeChildObservationEventSchema = z.enum([
  "pid-and-pgid-captured",
  "pid-only-captured",
  "pgid-only-captured",
  "pid-unknown",
  "pid-rejected",
]);
export type NativeChildObservationEvent = z.infer<typeof nativeChildObservationEventSchema>;

// ── Capability surface ───────────────────────────────────────────────────────

/**
 * Additive capability surface carried on the capability matrix's
 * `native` union member and on `AdapterCapabilities`. The
 * defaults are wired by the runtime (claude = fully-observed +
 * supported; codex = pid-only + not-supported, per M4.1
 * asymmetry).
 */
export const nativeSubagentSupportSchema = z.object({
  /** Whether the provider advertises a native subagent path. */
  supported: z.boolean(),
  /** The runtime's best-case observation level when this provider
   * spawns a native subagent. The dispatcher reads this field
   * (not the `observation` of a particular child record) when
   * deciding whether to dispatch via the native path. */
  defaultObservation: nativeChildObservationLevelSchema,
  /** Whether the runner can capture a pgid (typically true on
   * Linux; false when the provider binary hides its process
   * group). */
  capturesPgid: z.boolean(),
}).strict();
export type NativeSubagentSupport = z.infer<typeof nativeSubagentSupportSchema>;

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Cap map for the delegation policy. Mirrors
 * `leadAdmissionLimitsSchema`; same shape conventions. The
 * defaults (constants in `delegation-policy.ts`) live in code,
 * not in the schema, so callers can override via a meta-key
 * store without changing the wire shape.
 */
export const delegationLimitsSchema = z.object({
  /** Hard ceiling on concurrently-OBSERVABLE native subagents
   * across the whole runtime. Advisory-only levels are EXCLUDED
   * from this count — "prompts cannot enforce process quotas"
   * — but they ARE reported in
   * `delegationStatusSchema.unobservedChildrenByLevel`. */
  globalMaxObservableNativeSubagents: z.number().int().min(1).max(64),
  /** Hard ceiling on concurrently-observable native subagents
   * spawned under one parent invocation (same `(runId,
   * invocationId)`). */
  perInvocationMaxObservableNativeSubagents: z.number().int().min(1).max(16),
  /** Which observation levels count toward the global /
   * per-invocation cap. Only `"fully-observed"` ships enabled by
   * default; a future increment may allow `"pid-only"` once the
   * runtime has a per-pid liveness check. */
  observableLevelsForCap: z.array(nativeChildObservationLevelSchema).default(["fully-observed"]),
  /** Per-provider cap overrides (provider name → max). Empty by
   * default so providers are not silently capped. */
  perProviderMaxObservableNativeSubagents: z.record(z.string().max(64), z.number().int().min(0).max(64)).default({}),
  /** Observation levels that the runtime declares HARD-BUDGETED —
   * the dispatcher MUST refuse to pick the native-subagent path
   * when `hardBudgetRequired` is true and the provider's
   * `defaultObservation` is in this list. */
  hardBudgetRequiredObservationLevels: z.array(nativeChildObservationLevelSchema).default(["unobservable", "provider-internal"]),
}).strict();
export type DelegationLimits = z.infer<typeof delegationLimitsSchema>;

// ── Status (live counts + observation gap disclosure) ───────────────────────

/**
 * Live counts + observation-gap disclosure. The orchestrator (and
 * future renderer / CLI) reads this to display "X of Y
 * fully-observed children; ≥ M children at advisory levels" without
 * re-deriving the breakdown.
 */
export const delegationStatusSchema = z.object({
  limits: delegationLimitsSchema,
  /** Total observable native children across the runtime (rows
   * whose `observation ∈ limits.observableLevelsForCap`). */
  observableNativeChildCount: z.number().int().min(0).max(1024),
  /** Observable native children grouped by provider. */
  observableNativeChildCountByProvider: z.record(z.string().max(64), z.number().int().min(0).max(1024)),
  /** All native children grouped by observation level —
   *    INCLUDING advisory levels — so a renderer can show "≥ N
   *    unobservable children are out there" without making up a
   *    count. */
  unobservedChildrenByLevel: z.record(nativeChildObservationLevelSchema, z.number().int().min(0).max(1024)),
  /** Distinct provider names whose every observed row is in
   * `limits.hardBudgetRequiredObservationLevels`. A provider is
   * reported here only when EVERY row we have for it is at a
   * hard-budget level — a provider that also has any observable
   * row is excluded. */
  ungovernableProviders: z.array(z.string().max(64)),
}).strict();
export type DelegationStatus = z.infer<typeof delegationStatusSchema>;

// ── Dispatch decision union ──────────────────────────────────────────────────

/**
 * The dispatcher's verdict. Discriminated union so callers can
 * branch on `kind` without re-reading a flag.
 *
 *  - `native-subagent` — proceed via the provider's native
 *    subagent path. `chosenObservation` is what the runtime will
 *    count toward `limits.observableLevelsForCap`.
 *  - `managed-run` — proceed via a managed child run through the
 *    M3 / M5.2 admission path. Always available as a fallback.
 *  - `forbidden` — the dispatcher refuses the native path AND
 *    cannot safely fall back to a managed run for this caller
 *    (e.g. the caller has `allowNativeSubagents: false` AND the
 *    managed-run path is otherwise unavailable). `trippedPolicy`
 *    names the precise reason.
 */
export const dispatchDecisionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("native-subagent"),
    reason: z.string().min(1).max(1024),
    chosenObservation: nativeChildObservationLevelSchema,
  }).strict(),
  z.object({
    kind: z.literal("managed-run"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
    trippedPolicy: z.enum([
      "native-subagents-disabled",
      "no-observable-native-children",
      "hard-budget-required",
      "cross-host-native-blocked",
      "cross-provider-native-blocked",
    ]),
  }).strict(),
]);
export type DispatchDecision = z.infer<typeof dispatchDecisionSchema>;

// ── Dispatch input ───────────────────────────────────────────────────────────

/**
 * What the orchestrator hands the dispatcher. All cross-boundary
 * identity fields are validated by the schema so a malformed
 * input raises `INVALID_REQUEST` before the decision tree runs.
 */
export const delegationPolicyInputSchema = z.object({
  workspaceId: z.string().uuid(),
  hostId: z.string().min(1).max(128),
  providerVersion: z.string().min(1).max(256),
  /** The parent invocation's provider / workspace / host — `null`
   * for the very first dispatch (no parent). When non-null and
   * different from the corresponding new field, the dispatcher
   * forces `managed-run`. */
  parentProviderVersion: z.string().min(1).max(256).nullable(),
  parentWorkspaceId: z.string().uuid().nullable(),
  parentHostId: z.string().min(1).max(128).nullable(),
  invocationId: z.string().uuid(),
  providerNativeSubagentSupport: nativeSubagentSupportSchema,
  /** When `true`, the dispatcher MUST refuse to pick a
   * native-subagent path whose observation level is in
   * `limits.hardBudgetRequiredObservationLevels`. */
  hardBudgetRequired: z.boolean(),
  /** Per-call override: when `false`, the dispatcher refuses any
   * native-subagent path. */
  allowNativeSubagents: z.boolean(),
  /** Current observable count (across the runtime) at the time
   * the caller asked. The dispatcher reads this as an advisory
   * input — the canonical status is `readDelegationStatus`. */
  currentObservableNativeChildCount: z.number().int().min(0).max(1024),
  /** Observable count under this parent invocation. */
  currentObservableNativeChildCountForInvocation: z.number().int().min(0).max(1024),
  limits: delegationLimitsSchema,
}).strict();
export type DelegationPolicyInput = z.infer<typeof delegationPolicyInputSchema>;

// ── Observation record (input + stored) ──────────────────────────────────────

export const recordNativeChildObservationInputSchema = z.object({
  invocationId: z.string().uuid(),
  /** Per-invocation monotonic sequence. The runtime assigns this
   * when it observes the child; never re-uses a `(invocationId,
   * seq)` pair (the meta-row INSERT OR REPLACE would surface
   * `CONFLICT` via its `payloadDigest` divergence). */
  seq: z.number().int().min(1).max(1024),
  provider: z.string().min(1).max(64),
  pid: z.number().int().nullable(),
  pgid: z.number().int().nullable(),
  observation: nativeChildObservationLevelSchema,
  observedAt: z.string().datetime(),
}).strict();
export type RecordNativeChildObservationInput = z.infer<typeof recordNativeChildObservationInputSchema>;

export const nativeChildObservationRecordSchema = z.object({
  invocationId: z.string().uuid(),
  seq: z.number().int().min(1).max(1024),
  provider: z.string().min(1).max(64),
  pid: z.number().int().nullable(),
  pgid: z.number().int().nullable(),
  observation: nativeChildObservationLevelSchema,
  observedAt: z.string().datetime(),
  payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();
export type NativeChildObservationRecord = z.infer<typeof nativeChildObservationRecordSchema>;
