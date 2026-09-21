/**
 * M6.1 — workflow executor schemas.
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
 * The schema is deliberately split into many small `.strict()` objects
 * so each step body stays independent at the parse gate; the runtime
 * `validateDependencyGraph` helper (`src/runtime/db/workflow-graph.ts`)
 * consumes the parsed shape and refuses malformed graphs before any
 * step is dispatched.
 *
 * The settings module mirrors the M5.7 `PromptAnchorSettings` /
 * `resolvePromptAnchorSettings` pattern: callers pass `null`/absent
 * to use the defaults; pass a partial override to clamp / change
 * a single field.
 */
import { z } from "zod";
import { artifactKindSchema } from "./managed";

// ---------------------------------------------------------------------------
// Constants — caps and bounds the runtime enforces by construction.
// ---------------------------------------------------------------------------

/** Hard ceiling on `settings.maxFanout`. */
export const MAX_FANOUT = 16;
/** Default fan-out cap when caller omits the setting. */
export const DEFAULT_MAX_FANOUT = 4;
/** Default per-step timeout when the step body omits one. */
export const DEFAULT_STEP_TIMEOUT_MS = 30_000;
/** Minimum per-step timeout. Smaller values are clamped up. */
export const MIN_STEP_TIMEOUT_MS = 1_000;
/** Maximum per-step timeout. Larger values are clamped down. */
export const MAX_STEP_TIMEOUT_MS = 30 * 60_000;
/** Default poll interval for `wait` steps that poll a review. */
export const DEFAULT_WAIT_POLL_MS = 250;
/** Minimum poll interval (lower clamp). */
export const MIN_WAIT_POLL_MS = 50;
/** Maximum poll interval (upper clamp). */
export const MAX_WAIT_POLL_MS = 5_000;

/** Hard ceiling on the number of steps per workflow graph. */
export const MAX_STEPS_PER_WORKFLOW = 64;
/** Hard ceiling on the number of edges per workflow graph. */
export const MAX_EDGES_PER_WORKFLOW = 256;

/** Per-step stdout byte cap (mirrors the M3c.2 verifier bound). */
export const COMMAND_STDOUT_BYTE_CAP = 65_536;
/** Per-step stderr byte cap. */
export const COMMAND_STDERR_BYTE_CAP = 65_536;

// ---------------------------------------------------------------------------
// Step base — every step carries the same lifecycle metadata.
// ---------------------------------------------------------------------------

export const workflowStepKindSchema = z.enum([
  "agent",
  "command",
  "check",
  "approval",
  "artifact",
  "wait",
]);
export type WorkflowStepKind = z.infer<typeof workflowStepKindSchema>;

export const workflowInputRefSchema = z
  .object({
    stepId: z.string().min(1).max(128),
    outputKey: z.string().min(1).max(128),
  })
  .strict();
export type WorkflowInputRef = z.infer<typeof workflowInputRefSchema>;

export const workflowStepBaseFieldsSchema = z
  .object({
    id: z.string().min(1).max(128),
    kind: workflowStepKindSchema,
    displayName: z.string().min(1).max(256),
    dependsOn: z.array(z.string().min(1).max(128)).max(MAX_STEPS_PER_WORKFLOW).default([]),
    inputRefs: z.array(workflowInputRefSchema).max(MAX_STEPS_PER_WORKFLOW).default([]),
    outputKeys: z.array(z.string().min(1).max(128)).max(32).default([]),
    /** Per-step timeout in milliseconds. Clamped at runtime. */
    timeoutMs: z.number().int().min(MIN_STEP_TIMEOUT_MS).max(MAX_STEP_TIMEOUT_MS).optional(),
  })
  .strict();
export type WorkflowStepBaseFields = z.infer<typeof workflowStepBaseFieldsSchema>;

// ---------------------------------------------------------------------------
// Step bodies — discriminated on `kind`. Each body is `.strict()`.
// ---------------------------------------------------------------------------

export const workflowAgentBodySchema = z
  .object({
    runId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(256),
    parentInvocationId: z.string().uuid().nullable().default(null),
    canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
    prompt: z.string().min(1).max(8 * 1024),
    providerVersion: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
    method: z.string().min(1).max(128).default("agent.run"),
    scope: z.unknown().default({}),
    args: z.unknown().default({}),
    deadlineAt: z.string().datetime(),
    attemptedBy: z.string().min(1).max(256),
  })
  .strict();
export type WorkflowAgentBody = z.infer<typeof workflowAgentBodySchema>;

export const workflowCommandBodySchema = z
  .object({
    argv: z.array(z.string().min(1).max(1024)).min(1).max(64),
    env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
    cwd: z.string().min(1).max(4096).nullable().default(null),
    stdoutByteCap: z.number().int().min(1024).max(COMMAND_STDOUT_BYTE_CAP).default(COMMAND_STDOUT_BYTE_CAP),
    stderrByteCap: z.number().int().min(1024).max(COMMAND_STDERR_BYTE_CAP).default(COMMAND_STDERR_BYTE_CAP),
  })
  .strict();
export type WorkflowCommandBody = z.infer<typeof workflowCommandBodySchema>;

export const workflowCheckBodySchema = z
  .object({
    taskId: z.string().uuid(),
    runId: z.string().uuid().nullable().default(null),
    recipeId: z.string().uuid().optional(),
    command: z.string().trim().min(1).max(1024).optional(),
    argv: z.array(z.string().min(1).max(1024)).default([]),
    deadlineAt: z.string().datetime(),
  })
  .strict()
  .refine((value) => Boolean(value.recipeId) || Boolean(value.command), {
    message: "check step requires either recipeId or a command override",
  });
export type WorkflowCheckBody = z.infer<typeof workflowCheckBodySchema>;

export const workflowApprovalBodySchema = z
  .object({
    reviewId: z.string().uuid().optional(),
    attentionId: z.string().uuid().optional(),
    pollMs: z.number().int().min(MIN_WAIT_POLL_MS).max(MAX_WAIT_POLL_MS).default(DEFAULT_WAIT_POLL_MS),
    deadlineMs: z.number().int().min(100).max(MAX_STEP_TIMEOUT_MS),
    decidedBy: z.string().min(1).max(256),
  })
  .strict()
  .refine((value) => Boolean(value.reviewId) || Boolean(value.attentionId), {
    message: "approval step requires either reviewId or attentionId",
  });
export type WorkflowApprovalBody = z.infer<typeof workflowApprovalBodySchema>;

export const workflowArtifactBodySchema = z
  .object({
    taskId: z.string().uuid().nullable().default(null),
    runId: z.string().uuid().nullable().default(null),
    uri: z.string().min(1).max(2048),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The artifact's own kind (`input | context | evidence | output`). */
    artifactKind: artifactKindSchema,
    bytes: z.number().int().nonnegative(),
    mime: z.string().min(1).max(256),
    expiresAt: z.string().datetime().nullable().default(null),
  })
  .strict();
export type WorkflowArtifactBody = z.infer<typeof workflowArtifactBodySchema>;

export const workflowWaitBodySchema = z
  .object({
    timeoutMs: z.number().int().min(MIN_STEP_TIMEOUT_MS).max(MAX_STEP_TIMEOUT_MS),
  })
  .strict();
export type WorkflowWaitBody = z.infer<typeof workflowWaitBodySchema>;

// ---------------------------------------------------------------------------
// Step schema — `z.discriminatedUnion("kind", ...)` over the six bodies.
// ---------------------------------------------------------------------------

export const workflowStepSchema = z.discriminatedUnion("kind", [
  workflowStepBaseFieldsSchema.merge(workflowAgentBodySchema).safeExtend({
    kind: z.literal("agent"),
  }),
  workflowStepBaseFieldsSchema.merge(workflowCommandBodySchema).safeExtend({
    kind: z.literal("command"),
  }),
  workflowStepBaseFieldsSchema.merge(workflowCheckBodySchema).safeExtend({
    kind: z.literal("check"),
  }),
  workflowStepBaseFieldsSchema.merge(workflowApprovalBodySchema).safeExtend({
    kind: z.literal("approval"),
  }),
  workflowStepBaseFieldsSchema.merge(workflowArtifactBodySchema).safeExtend({
    kind: z.literal("artifact"),
  }),
  workflowStepBaseFieldsSchema.merge(workflowWaitBodySchema).safeExtend({
    kind: z.literal("wait"),
  }),
]);
export type WorkflowStep = z.infer<typeof workflowStepSchema>;
export type WorkflowStepInput = z.input<typeof workflowStepSchema>;

// ---------------------------------------------------------------------------
// Graph schema — `workflowId` + bounded step / edge arrays.
// ---------------------------------------------------------------------------

export const workflowEdgeSchema = z
  .object({
    from: z.string().min(1).max(128),
    to: z.string().min(1).max(128),
  })
  .strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowGraphSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    steps: z.array(workflowStepSchema).min(1).max(MAX_STEPS_PER_WORKFLOW),
    edges: z.array(workflowEdgeSchema).max(MAX_EDGES_PER_WORKFLOW).default([]),
    createdBy: z.string().min(1).max(256),
  })
  .strict();
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
export type WorkflowGraphInput = z.input<typeof workflowGraphSchema>;

// ---------------------------------------------------------------------------
// Settings — three primitive keys with clamp + defaults.
// ---------------------------------------------------------------------------

export const workflowExecutorMaxFanoutSchema = z.number().int().min(1).max(MAX_FANOUT);
export const workflowExecutorDefaultStepTimeoutMsSchema = z
  .number()
  .int()
  .min(MIN_STEP_TIMEOUT_MS)
  .max(MAX_STEP_TIMEOUT_MS);
export const workflowExecutorWaitPollMsSchema = z
  .number()
  .int()
  .min(MIN_WAIT_POLL_MS)
  .max(MAX_WAIT_POLL_MS);

export const workflowExecutorSettingsSchema = z
  .object({
    maxFanout: workflowExecutorMaxFanoutSchema,
    defaultStepTimeoutMs: workflowExecutorDefaultStepTimeoutMsSchema,
    waitPollMs: workflowExecutorWaitPollMsSchema,
  })
  .strict();
export type WorkflowExecutorSettings = z.infer<typeof workflowExecutorSettingsSchema>;

/** Caller-facing partial input — `null`/absent → defaults + clamp. */
export type WorkflowExecutorSettingsInput = Partial<{
  maxFanout: number;
  defaultStepTimeoutMs: number;
  waitPollMs: number;
}>;

/**
 * Resolve caller-supplied settings into a fully-clamped
 * `WorkflowExecutorSettings`. `null`/absent fields fall back to the
 * documented defaults; out-of-range values are silently clamped to
 * the schema bounds so a caller cannot accidentally oversize the
 * fan-out.
 */
export function resolveWorkflowExecutorSettings(
  input: WorkflowExecutorSettingsInput | null | undefined,
): WorkflowExecutorSettings {
  const raw = (input && typeof input === "object" ? input : {}) as WorkflowExecutorSettingsInput;
  return workflowExecutorSettingsSchema.parse({
    maxFanout: clampInt(raw.maxFanout, DEFAULT_MAX_FANOUT, 1, MAX_FANOUT),
    defaultStepTimeoutMs: clampInt(raw.defaultStepTimeoutMs, DEFAULT_STEP_TIMEOUT_MS, MIN_STEP_TIMEOUT_MS, MAX_STEP_TIMEOUT_MS),
    waitPollMs: clampInt(raw.waitPollMs, DEFAULT_WAIT_POLL_MS, MIN_WAIT_POLL_MS, MAX_WAIT_POLL_MS),
  });
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

// ---------------------------------------------------------------------------
// Result — `workflowResultSchema` (discriminated on `kind`).
//
// M7.5 — the `completed` arm carries an optional `usageRollup`
// that aggregates reported token counts and the pinned
// `pricingTierDigest` for the run. The rollup is `null` when no
// step in the workflow reported usage (e.g. a workflow of only
// `command` + `wait` steps). Pricing changes between runs surface
// as different digests — the renderer is responsible for showing
// "estimated, last verified at <capturedAt>" + an explicit
// freshness interval; the runtime NEVER silently substitutes a
// different tier.
// ---------------------------------------------------------------------------

/**
 * Aggregated usage / spend for a completed workflow. `null` when
 * no step reported usage. Pricing digest is the `tierDigest` of
 * the pricing-catalog row used to convert tokens to USD; absent
 * when the provider did not pin a tier.
 */
export const workflowUsageRollupSchema = z
  .object({
    inputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    cacheReadTokens: z.number().int().min(0),
    cacheWriteTokens: z.number().int().min(0),
    costUsd: z.number().nonnegative().nullable(),
    pricingTierDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    pricingTierDigestFreshAt: z.string().datetime().nullable(),
  })
  .strict();
export type WorkflowUsageRollup = z.infer<typeof workflowUsageRollupSchema>;

export const workflowResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("completed"),
      workflowId: z.string().min(1).max(128),
      stepOutputs: z.record(z.string(), z.unknown()),
      auditDigest: z.string().regex(/^[0-9a-f]{64}$/),
      completedAt: z.string().datetime(),
      usageRollup: workflowUsageRollupSchema.nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("failed"),
      workflowId: z.string().min(1).max(128),
      stepOutputs: z.record(z.string(), z.unknown()),
      auditDigest: z.string().regex(/^[0-9a-f]{64}$/),
      failedAt: z.string().datetime(),
      failedStepId: z.string().min(1).max(128),
      failure: z.object({
        code: z.string().min(1).max(64),
        message: z.string().max(4096),
      }).strict(),
      usageRollup: workflowUsageRollupSchema.nullable().default(null),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cancelled"),
      workflowId: z.string().min(1).max(128),
      stepOutputs: z.record(z.string(), z.unknown()),
      auditDigest: z.string().regex(/^[0-9a-f]{64}$/),
      cancelledAt: z.string().datetime(),
      cancelledStepId: z.string().min(1).max(128).nullable(),
      usageRollup: workflowUsageRollupSchema.nullable().default(null),
    })
    .strict(),
]);
export type WorkflowResult = z.infer<typeof workflowResultSchema>;

// ---------------------------------------------------------------------------
// IPC envelopes — used by the `run-workflow` method.
//
// The renderer / preload surfaces both the graph and an optional settings
// override. The Zod schemas are the single source of truth for the wire shape
// (the dispatcher handler re-validates inside `runWorkflow`; the request
// envelope below is parsed at the protocol boundary so an oversized or
// malformed frame is rejected before any state mutation).
// ---------------------------------------------------------------------------

export const runWorkflowInputSchema = z
  .object({
    workflow: workflowGraphSchema,
    settings: workflowExecutorSettingsSchema.partial().nullable().optional(),
  })
  .strict();
export type RunWorkflowInput = z.input<typeof runWorkflowInputSchema>;
export type RunWorkflowArgs = z.output<typeof runWorkflowInputSchema>;

/**
 * The protocol-layer conflict envelope. The dispatcher handler unwraps the
 * `WorkflowResult` and surfaces validation failures / `AppError` rejections
 * as this shape so the renderer doesn't need to parse `Failure` itself.
 */
export const runWorkflowConflictResultSchema = z
  .object({
    kind: z.literal("conflict"),
    reason: z.string().min(1).max(4096),
  })
  .strict();
export type RunWorkflowConflictResult = z.infer<typeof runWorkflowConflictResultSchema>;
