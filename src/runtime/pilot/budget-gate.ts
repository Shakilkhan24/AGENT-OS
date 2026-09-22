/**
 * M9.5 — pilot refuse-to-spend budget gate.
 *
 * The gate classifies a single observation's reported USD cost
 * against three independent caps:
 *
 *   - `perInvocationCapUsd` — single invocation cannot exceed X USD.
 *   - `perAttemptCapUsd`    — cumulative cost within one attempt cannot exceed X.
 *   - `perProfileCapUsd`    — cumulative cost across the participant's
 *                             full pilot cannot exceed X.
 *
 * Behaviour:
 *
 *   - `ok`     — output is below every cap and below the warn fraction.
 *   - `warn`   — output has crossed `warnAtFraction` of any cap. The
 *                runner logs the warning but does NOT stop; it emits a
 *                `stop.requested` event with reason `pilot-budget-warn`
 *                so a downstream consumer can surface a "budget
 *                nearing cap" indicator. The accumulate on the running
 *                tally still happens.
 *   - `refuse` — output has crossed the cap itself. The runner MUST
 *                halt the next dispatch and emit `stop.requested`
 *                with reason `pilot-budget-refused`.
 *
 * Unknown-cost discipline: when `observed.costUsd === null`, the gate
 * returns `ok` with `unknownCost: true` and contributes zero to the
 * tally. We NEVER substitute an estimate.
 */
import type { z } from "zod";
import type { observationUsageSchema } from "../orchestration/observation";
import type { PilotBudget, BudgetEvent } from "../../shared/pilot-schema";
import { AppError } from "../../shared/errors";

/** Inferred type of `observationUsageSchema`. The runner reads this directly. */
export type ObservationUsage = z.infer<typeof observationUsageSchema>;

/** Subset of `ObservationUsage` this gate reads. */
export type ObservedUsage = Pick<ObservationUsage, "costUsd">;

/** Running tally maintained by the runner. */
export interface PilotBudgetState {
  /** Cumulative spend in the current attempt (USD). */
  attemptSpentUsd: number;
  /** Cumulative spend across this participant's full pilot (USD). */
  profileSpentUsd: number;
}

/** The three USD caps (excluding `warnAtFraction`). */
export type BudgetCap = "perInvocationCapUsd" | "perAttemptCapUsd" | "perProfileCapUsd";

/** Classification result returned by `classifySpend`. */
export type SpendClassification =
  | { kind: "ok"; reason: string; unknownCost: boolean }
  | { kind: "warn"; reason: string; cap: BudgetCap; capUsd: number; observedUsd: number; unknownCost: boolean }
  | { kind: "refuse"; reason: string; cap: BudgetCap; capUsd: number; observedUsd: number; unknownCost: false };

/** Options for `classifySpend`. */
export interface ClassifySpendInput {
  /** The observation we just received from the provider. */
  observed: ObservedUsage;
  /** Running tally for this attempt + profile. */
  state: PilotBudgetState;
  /** The pilot's three caps + warn fraction. */
  budget: PilotBudget;
}

/**
 * Pure classifier. No I/O. Returns `ok | warn | refuse` with the
 * relevant cap name (when applicable) and an explanation. The caller
 * (the runner) is responsible for emitting `BudgetEvent` records
 * from the `warn` / `refuse` results.
 */
export function classifySpend(input: ClassifySpendInput): SpendClassification {
  const { observed, state, budget } = input;

  // Unknown-cost discipline: contributes 0 to the tally and is reported
  // separately. We do NOT substitute an estimate.
  if (observed.costUsd === null) {
    return {
      kind: "ok",
      reason: "unknown cost; contributes zero to tally and is reported separately",
      unknownCost: true,
    };
  }

  const observedUsd = observed.costUsd;
  const attempts: Array<{ cap: BudgetCap; capUsd: number; runningUsd: number }> = [
    { cap: "perInvocationCapUsd", capUsd: budget.perInvocationCapUsd, runningUsd: observedUsd },
    { cap: "perAttemptCapUsd", capUsd: budget.perAttemptCapUsd, runningUsd: state.attemptSpentUsd + observedUsd },
    { cap: "perProfileCapUsd", capUsd: budget.perProfileCapUsd, runningUsd: state.profileSpentUsd + observedUsd },
  ];

  // First, refusal takes priority over warning: if any cap is breached,
  // refuse immediately.
  for (const { cap, capUsd, runningUsd } of attempts) {
    if (capUsd > 0 && runningUsd > capUsd) {
      return {
        kind: "refuse",
        reason: `${cap} breached: ${runningUsd.toFixed(4)} > ${capUsd.toFixed(4)} USD`,
        cap,
        capUsd,
        observedUsd,
        unknownCost: false,
      };
    }
  }

  // Next, the warn-at-fraction: if any cap has crossed the warn fraction
  // for this observation, return `warn`.
  for (const { cap, capUsd, runningUsd } of attempts) {
    if (capUsd > 0 && runningUsd >= budget.warnAtFraction * capUsd) {
      return {
        kind: "warn",
        reason: `${cap} at ${(runningUsd / capUsd * 100).toFixed(1)}% of cap (${runningUsd.toFixed(4)} / ${capUsd.toFixed(4)} USD)`,
        cap,
        capUsd,
        observedUsd,
        unknownCost: false,
      };
    }
  }

  return { kind: "ok", reason: "below all caps", unknownCost: false };
}

/**
 * Wrap a USD accumulation: returns the updated `PilotBudgetState`
 * with `attemptSpentUsd` + `profileSpentUsd` incremented by the
 * observed USD. When `costUsd === null` the state is unchanged.
 */
export function accumulateSpend(state: PilotBudgetState, observed: ObservedUsage): PilotBudgetState {
  if (observed.costUsd === null) return state;
  return {
    attemptSpentUsd: state.attemptSpentUsd + observed.costUsd,
    profileSpentUsd: state.profileSpentUsd + observed.costUsd,
  };
}

/**
 * Build a `BudgetEvent` record from a `warn | refuse` classification.
 * The caller fills in `at`, `participantId`, and `attemptId`.
 */
export function buildBudgetEvent(args: {
  classification: Extract<SpendClassification, { kind: "warn" | "refuse" }>;
  participantId: string;
  attemptId: string;
  at: string;
}): BudgetEvent {
  return {
    at: args.at,
    kind: args.classification.kind,
    cap: args.classification.cap,
    observedUsd: args.classification.observedUsd,
    capUsd: args.classification.capUsd,
    participantId: args.participantId,
    attemptId: args.attemptId,
    reason: args.classification.reason,
  };
}

/**
 * Raise an `AppError` with code `BUDGET_EXCEEDED` for the refuse
 * classification. Used by the runner to halt dispatch when the
 * gate says refuse.
 */
export function budgetExceededError(classification: Extract<SpendClassification, { kind: "refuse" }>): AppError {
  return new AppError("BUDGET_EXCEEDED", classification.reason, {
    sourceId: "runtime/pilot/budget-gate",
    retryable: false,
  });
}

// `observationUsageSchema` is referenced via the type-only import above;
// the runner reads `ObservationUsage` (its inferred type) at runtime.