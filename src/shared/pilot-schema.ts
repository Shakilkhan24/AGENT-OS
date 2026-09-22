/**
 * M9.5 — pilot harness schemas.
 *
 * The M9.5 bullet (FUTURE/IMPLEMENTATION-README.md line 289) reads:
 *
 *   > Compare useful tasks against the user's current terminal workflow
 *   > and native provider workflow with matched versions/budgets.
 *   > Measure accepted outcomes, review/recovery effort, defects, all
 *   > attempts and unknown cost. Counterbalance task order; small pilots
 *   > cannot establish universal productivity multipliers.
 *
 * This module defines the typed contract for the pilot: fixtures,
 * budgets, attempt records, and the aggregate `pilotReportSchema`. The
 * schemas are deliberately `.strict()` so every field crossing the
 * runner/CLI boundary is rejected at parse time.
 *
 * The `caveats[]` field on `pilotReportSchema` is the literal home of
 * "small pilots cannot establish universal productivity multipliers".
 * It is a first-class report field, not buried in prose — see
 * `aggregate.ts` for the four-line default set.
 */
import { z } from "zod";
import { workflowGraphSchema } from "./workflow-executor-schema";

// ---------------------------------------------------------------------------
// Conditions + families
// ---------------------------------------------------------------------------

/** The three compared workflows in a pilot. */
export const pilotConditionSchema = z.enum([
  "terminal-baseline",
  "native-provider",
  "minimal",
]);
export type PilotCondition = z.infer<typeof pilotConditionSchema>;

/** Five fixture families from `FUTURE/docs/research/10-evaluation-productivity.md §3`. */
export const fixtureFamilySchema = z.enum([
  "routine-change",
  "context-handoff",
  "parallel-integration",
  "interruption-recovery",
  "recipe-review",
]);
export type FixtureFamily = z.infer<typeof fixtureFamilySchema>;

// ---------------------------------------------------------------------------
// Acceptance-rule discriminated union
// ---------------------------------------------------------------------------

const fixtureAcceptanceBaseFieldsSchema = z
  .object({
    /** Human-readable label, e.g. "candidate-tree-matches-routine-01". */
    label: z.string().min(1).max(128),
    /** Free-form prose describing the rule's intent. */
    description: z.string().max(4096).default(""),
    /** Whether a failure rejects the attempt (true) or just flags it (false). */
    mustPass: z.boolean().default(true),
  })
  .strict();

const checksPassRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("checks-pass"),
  /** Required check names that must be in `passed` status. */
  requiredCheckNames: z.array(z.string().min(1).max(128)).min(1).max(32),
});

const candidateTreeUnchangedRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("candidate-tree-unchanged"),
  /** Path-pattern allowlist (project-relative globs). */
  allowedScope: z.array(z.string().min(1).max(512)).min(1).max(64),
});

const candidateDiffMatchesRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("candidate-diff-matches"),
  /** Expected sha256 of the candidate diff. */
  expectedSha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const reviewAcceptedRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("review-accepted"),
  /** Required review status (`accepted` for M9.5). */
  requiredStatus: z.enum(["accepted"]),
});

const dispatchNotReplayedRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("dispatch-not-replayed"),
  /** Reference invocation IDs that MUST be present exactly once. */
  referenceInvocationIds: z.array(z.string().uuid()).min(1).max(32),
});

const costWithinRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("cost-within"),
  /** Cap in USD (the runner compares against `observationUsage.costUsd`). */
  capUsd: z.number().nonnegative(),
});

const humanMinutesWithinRuleSchema = fixtureAcceptanceBaseFieldsSchema.safeExtend({
  kind: z.literal("human-minutes-within"),
  /** Cap in human minutes (the runner compares against `attemptRecord.humanMinutes`). */
  capMinutes: z.number().nonnegative(),
});

export const fixtureAcceptanceRuleSchema = z.discriminatedUnion("kind", [
  checksPassRuleSchema,
  candidateTreeUnchangedRuleSchema,
  candidateDiffMatchesRuleSchema,
  reviewAcceptedRuleSchema,
  dispatchNotReplayedRuleSchema,
  costWithinRuleSchema,
  humanMinutesWithinRuleSchema,
]);
export type FixtureAcceptanceRule = z.infer<typeof fixtureAcceptanceRuleSchema>;

// ---------------------------------------------------------------------------
// Fixture driver — per-condition invocation metadata
// ---------------------------------------------------------------------------

export const fixtureDriverSchema = z
  .object({
    condition: pilotConditionSchema,
    /** Provider invocation key (e.g. "claude", "codex", "manual-terminal"). */
    invocation: z.string().min(1).max(128),
    /** Pinned provider version (e.g. "1.2.5" or "n/a" for terminal-baseline). */
    providerPin: z.string().min(1).max(256),
    /** Reference document pointer (path or URL) for the driver. */
    reference: z.string().min(1).max(2048),
  })
  .strict();
export type FixtureDriver = z.infer<typeof fixtureDriverSchema>;

// ---------------------------------------------------------------------------
// Fixture — the full per-task schema
// ---------------------------------------------------------------------------

export const fixtureSchema = z
  .object({
    /** Stable fixture id, e.g. "routine-01". */
    id: z.string().regex(/^[a-z0-9-]{1,64}$/),
    family: fixtureFamilySchema,
    /** Display name (human). */
    displayName: z.string().min(1).max(256),
    /** Project revision the fixture was authored against. */
    baseRevision: z.string().min(1).max(256),
    /** Path-pattern allowlist for `candidate-tree-unchanged` (shared across rules). */
    allowedScope: z.array(z.string().min(1).max(512)).min(1).max(64),
    /** Free-form input descriptions (files, snippets). */
    contextInputs: z.array(z.string().min(1).max(1024)).max(64).default([]),
    /** Container / VM image tag (e.g. "ubuntu-22.04"). */
    environmentImage: z.string().min(1).max(256),
    /** Hardware allocation, e.g. "2 vCPU / 4 GiB". */
    hardwareAllocation: z.string().min(1).max(256),
    /** Per-attempt timeout in minutes. */
    timeoutMinutes: z.number().int().min(1).max(24 * 60),
    /** Per-fixture attempt budget (max attempts allowed). */
    attemptBudget: z.number().int().min(1).max(64),
    /** Schema/grammar version of the grader (bumped when rule kinds change). */
    graderVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    /** Acceptance rules — the contract for "accepted". */
    acceptance: z.array(fixtureAcceptanceRuleSchema).min(1).max(16),
    /** Drivers — exactly three (one per condition). */
    drivers: z.array(fixtureDriverSchema).length(3),
    /** Optional workflow body — only used by the `minimal` driver. */
    minimalWorkflow: workflowGraphSchema.optional(),
  })
  .strict()
  .refine(
    (value) => {
      const conditions = new Set(value.drivers.map((d) => d.condition));
      return conditions.size === 3;
    },
    { message: "fixture drivers must cover all three conditions exactly once" },
  );
export type Fixture = z.infer<typeof fixtureSchema>;
export type FixtureInput = z.input<typeof fixtureSchema>;

// ---------------------------------------------------------------------------
// Budget — three independent USD caps with warn-at-fraction
// ---------------------------------------------------------------------------

export const pilotBudgetSchema = z
  .object({
    perInvocationCapUsd: z.number().nonnegative(),
    perAttemptCapUsd: z.number().nonnegative(),
    perProfileCapUsd: z.number().nonnegative(),
    /** Fraction of any cap that triggers a warn (default 0.8). */
    warnAtFraction: z.number().min(0).max(1).default(0.8),
  })
  .strict();
export type PilotBudget = z.infer<typeof pilotBudgetSchema>;

// ---------------------------------------------------------------------------
// Attempt outcome + record
// ---------------------------------------------------------------------------

export const attemptOutcomeSchema = z.enum([
  "accepted",
  "rejected",
  "abandoned",
  "timeout",
  "unknown",
]);
export type AttemptOutcome = z.infer<typeof attemptOutcomeSchema>;

/** Re-declared here so `acceptanceDecisionSchema.ruleKind` doesn't reach
 *  into the discriminated union's `.shape.kind` (which is `undefined`
 *  in Zod 4). The literal set matches the seven `kind` literals. */
export const acceptanceRuleKindSchema = z.enum([
  "checks-pass",
  "candidate-tree-unchanged",
  "candidate-diff-matches",
  "review-accepted",
  "dispatch-not-replayed",
  "cost-within",
  "human-minutes-within",
]);
export type AcceptanceRuleKind = z.infer<typeof acceptanceRuleKindSchema>;

export const acceptanceDecisionSchema = z
  .object({
    ruleKind: acceptanceRuleKindSchema,
    ruleLabel: z.string().min(1).max(128),
    passed: z.boolean(),
    detail: z.string().max(1024).default(""),
  })
  .strict();
export type AcceptanceDecision = z.infer<typeof acceptanceDecisionSchema>;

export const attemptRecordSchema = z
  .object({
    attemptId: z.string().uuid(),
    pilotId: z.string().min(1).max(128),
    charterVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    graderVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    participantId: z.string().min(1).max(64),
    conditionId: pilotConditionSchema,
    fixtureId: z.string().regex(/^[a-z0-9-]{1,64}$/),
    /** 1-based per `(participant, fixture)` order. */
    attemptOrder: z.number().int().min(1).max(64),
    /** 0-based position in the participant's condition order. */
    conditionPosition: z.number().int().min(0).max(2),
    outcome: attemptOutcomeSchema,
    humanMinutes: z.number().nonnegative(),
    startedAt: z.string().datetime(),
    endedAt: z.string().datetime(),
    /** Reported USD cost; null when the provider did not report. */
    costUsd: z.number().nonnegative().nullable(),
    /** True when `costUsd === null` — never substituted with an estimate. */
    unknownCost: z.boolean(),
    /** Optional failure record (mirrors `failureSchema`). */
    failure: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().max(4096),
      })
      .strict()
      .nullable()
      .default(null),
    acceptanceDecisions: z.array(acceptanceDecisionSchema),
    providerFingerprint: z.string().min(1).max(256),
  })
  .strict();
export type AttemptRecord = z.infer<typeof attemptRecordSchema>;

// ---------------------------------------------------------------------------
// Budget events — surfaced to the aggregate report
// ---------------------------------------------------------------------------

export const budgetEventKindSchema = z.enum(["warn", "refuse"]);
export type BudgetEventKind = z.infer<typeof budgetEventKindSchema>;

export const budgetEventSchema = z
  .object({
    at: z.string().datetime(),
    kind: budgetEventKindSchema,
    cap: z.enum(["perInvocationCapUsd", "perAttemptCapUsd", "perProfileCapUsd"]),
    observedUsd: z.number().nonnegative().nullable(),
    capUsd: z.number().nonnegative(),
    participantId: z.string().min(1).max(64),
    attemptId: z.string().uuid(),
    reason: z.string().max(4096),
  })
  .strict();
export type BudgetEvent = z.infer<typeof budgetEventSchema>;

// ---------------------------------------------------------------------------
// Aggregate report — carries `caveats[]` as a first-class field
// ---------------------------------------------------------------------------

export const pilotReportCohortSchema = z
  .object({
    participantIds: z.array(z.string().min(1).max(64)).min(1).max(64),
    /** Map of participant → ordered condition array (length 3). */
    conditionOrderByParticipant: z
      .record(z.string().min(1).max(64), z.array(pilotConditionSchema).length(3))
      .default({}),
  })
  .strict();
export type PilotReportCohort = z.infer<typeof pilotReportCohortSchema>;

export const pilotReportTotalsSchema = z
  .object({
    attempts: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    abandoned: z.number().int().nonnegative(),
    timeout: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    unknownCostAttempts: z.number().int().nonnegative(),
    budgetRefusals: z.number().int().nonnegative(),
  })
  .strict();
export type PilotReportTotals = z.infer<typeof pilotReportTotalsSchema>;

export const pilotReportByConditionSchema = z
  .object({
    condition: pilotConditionSchema,
    attempts: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    totalCostUsd: z.number().nonnegative(),
    meanHumanMinutes: z.number().nonnegative(),
  })
  .strict();
export type PilotReportByCondition = z.infer<typeof pilotReportByConditionSchema>;

export const pilotReportByFamilySchema = z
  .object({
    family: fixtureFamilySchema,
    attempts: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
  })
  .strict();
export type PilotReportByFamily = z.infer<typeof pilotReportByFamilySchema>;

/** The honest-limit lines every pilot report must carry by default. */
export const DEFAULT_PILOT_CAVEATS = Object.freeze([
  "Small cohort (N=6, Williams 3×6 in one balanced block): this pilot cannot establish universal productivity multipliers.",
  "Counterbalance scope: condition order and adjacent-pair balance are balanced within the 3×6 square; carry-over across fixtures is NOT balanced.",
  "Unknown-cost discipline: when costUsd === null, attempts are reported as unknownCost and contribute zero to totalCostUsd; estimates are never substituted.",
  "3-trial measurement scope: per (participant, fixture, condition) we record one attempt; the pilot does not estimate within-attempt variance.",
]);

export const pilotReportSchema = z
  .object({
    pilotId: z.string().min(1).max(128),
    charterVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    graderVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    generatedAt: z.string().datetime(),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    cohort: pilotReportCohortSchema,
    totals: pilotReportTotalsSchema,
    byCondition: z.array(pilotReportByConditionSchema).min(1),
    byFamily: z.array(pilotReportByFamilySchema),
    perAttempt: z.array(attemptRecordSchema),
    budgetEvents: z.array(budgetEventSchema),
    caveats: z.array(z.string().min(1).max(1024)).min(1),
  })
  .strict();
export type PilotReport = z.infer<typeof pilotReportSchema>;

// ---------------------------------------------------------------------------
// Charter — runtime contract loaded by the runner
// ---------------------------------------------------------------------------

export const pilotCharterSchema = z
  .object({
    pilotId: z.string().min(1).max(128),
    charterVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    graderVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    participantIds: z.array(z.string().min(1).max(64)).min(1).max(64),
    seed: z.string().regex(/^[0-9a-f]{1,64}$/),
    budget: pilotBudgetSchema,
    /** Path under `--fixtures-dir` to load fixture JSON files. */
    fixtureGlob: z.string().min(1).max(512).default("**/*.fixture.json"),
    /** Canary tokens to plant in every attempt record. */
    canaries: z
      .array(z.object({ name: z.string().min(1).max(64), value: z.string().min(1).max(256) }).strict())
      .default([]),
  })
  .strict();
export type PilotCharter = z.infer<typeof pilotCharterSchema>;
export type PilotCharterInput = z.input<typeof pilotCharterSchema>;