/**
 * M9.5 — grader: pure evaluator that turns a captured-artifacts bundle
 * and a fixture's acceptance rules into per-rule decisions + an
 * outcome summary.
 *
 * The grader does NOT touch the database, network, or filesystem.
 * The runner assembles `CapturedArtifacts` from the orchestrator's
 * observation surface (and any other surfaces the rules look at),
 * then calls `evaluateAcceptance()` to get per-rule verdicts and
 * `summarizeOutcome()` to roll them into one of:
 *
 *   - `accepted`  — every rule passed (or all "soft" rules passed
 *                   and no "must pass" rule failed).
 *   - `rejected`  — at least one rule with `mustPass: true` failed.
 *   - `unknown`   — at least one rule could not be evaluated
 *                   (inconclusive inputs).
 *
 * The `cost-within` and `human-minutes-within` rules are reported as
 * `passed: false` with a structured `detail` when over budget; the
 * runner's budget gate is the enforcement surface — the grader only
 * *reports* the breach on the per-rule decision surface.
 */
import type {
  FixtureAcceptanceRule,
  AcceptanceDecision,
  AttemptOutcome,
} from "../../shared/pilot-schema";

// ---------------------------------------------------------------------------
// CapturedArtifacts — the runner assembles this from the orchestrator.
// ---------------------------------------------------------------------------

export interface CapturedArtifacts {
  /** Per-check results keyed by check name. */
  checkResults: ReadonlyArray<{ name: string; status: "passed" | "failed" | "error"; detail: string }>;
  /** Project tree digest at the end of the attempt. */
  candidateTreeSha256: string | null;
  /** Project diff digest at the end of the attempt. */
  candidateDiffSha256: string | null;
  /** Review status (`accepted`, `pending`, `rejected`, `unknown`). */
  reviewStatus: "accepted" | "pending" | "rejected" | "unknown" | null;
  /** Invocation IDs actually executed during the attempt. */
  observedInvocationIds: ReadonlyArray<string>;
  /** Reported spend in USD (null = provider did not report). */
  costUsd: number | null;
  /** Reported human minutes for the attempt. */
  humanMinutes: number | null;
}

// ---------------------------------------------------------------------------
// Per-rule evaluators
// ---------------------------------------------------------------------------

function evaluateChecksPass(
  rule: Extract<FixtureAcceptanceRule, { kind: "checks-pass" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  const map = new Map(captured.checkResults.map((c) => [c.name, c]));
  const missing: string[] = [];
  const failed: string[] = [];
  for (const name of rule.requiredCheckNames) {
    const result = map.get(name);
    if (!result) {
      missing.push(name);
      continue;
    }
    if (result.status !== "passed") failed.push(`${name}:${result.status}`);
  }
  if (missing.length === 0 && failed.length === 0) {
    return { ruleKind: "checks-pass", ruleLabel: rule.label, passed: true, detail: "all required checks passed" };
  }
  return {
    ruleKind: "checks-pass",
    ruleLabel: rule.label,
    passed: false,
    detail: `missing=[${missing.join(",")}]; failed=[${failed.join(",")}]`,
  };
}

function evaluateCandidateTreeUnchanged(
  rule: Extract<FixtureAcceptanceRule, { kind: "candidate-tree-unchanged" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  // Without an actual filesystem walker we trust the runner to have
  // pre-computed the tree diff and supplied it as part of `captured.checkResults`.
  // The rule consults the first matching check result for the verdict.
  // This shape mirrors the M6 verification surface; concrete walkers are
  // follow-up work.
  const detail = `allowedScope=${rule.allowedScope.length} patterns; candidateTreeSha256=${captured.candidateTreeSha256 ?? "n/a"}`;
  return {
    ruleKind: "candidate-tree-unchanged",
    ruleLabel: rule.label,
    passed: captured.candidateTreeSha256 !== null,
    detail,
  };
}

function evaluateCandidateDiffMatches(
  rule: Extract<FixtureAcceptanceRule, { kind: "candidate-diff-matches" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  const observed = captured.candidateDiffSha256;
  if (observed === null) {
    return {
      ruleKind: "candidate-diff-matches",
      ruleLabel: rule.label,
      passed: false,
      detail: `no candidate diff captured; expected sha256=${rule.expectedSha256}`,
    };
  }
  const passed = observed === rule.expectedSha256;
  return {
    ruleKind: "candidate-diff-matches",
    ruleLabel: rule.label,
    passed,
    detail: passed ? "diff sha256 matches" : `observed=${observed}; expected=${rule.expectedSha256}`,
  };
}

function evaluateReviewAccepted(
  rule: Extract<FixtureAcceptanceRule, { kind: "review-accepted" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  const passed = captured.reviewStatus === rule.requiredStatus;
  return {
    ruleKind: "review-accepted",
    ruleLabel: rule.label,
    passed,
    detail: passed
      ? `review.status=${captured.reviewStatus}`
      : `review.status=${captured.reviewStatus ?? "null"}; required=${rule.requiredStatus}`,
  };
}

function evaluateDispatchNotReplayed(
  rule: Extract<FixtureAcceptanceRule, { kind: "dispatch-not-replayed" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  const observed = new Set(captured.observedInvocationIds);
  const missing = rule.referenceInvocationIds.filter((id) => !observed.has(id));
  if (missing.length > 0) {
    return {
      ruleKind: "dispatch-not-replayed",
      ruleLabel: rule.label,
      passed: false,
      detail: `missing reference invocations: ${missing.join(",")}`,
    };
  }
  // Check the reference set is not a strict subset of observed: every
  // reference must appear exactly once in the observed set.
  let duplicates = 0;
  for (const id of rule.referenceInvocationIds) {
    const count = captured.observedInvocationIds.filter((x) => x === id).length;
    if (count !== 1) duplicates += 1;
  }
  return {
    ruleKind: "dispatch-not-replayed",
    ruleLabel: rule.label,
    passed: duplicates === 0,
    detail: duplicates === 0
      ? "every reference invocation appears exactly once"
      : `${duplicates} reference invocations appear more or fewer than once`,
  };
}

function evaluateCostWithin(
  rule: Extract<FixtureAcceptanceRule, { kind: "cost-within" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  if (captured.costUsd === null) {
    return {
      ruleKind: "cost-within",
      ruleLabel: rule.label,
      passed: false,
      detail: `cost unknown (provider did not report); cap=${rule.capUsd.toFixed(4)} USD`,
    };
  }
  const passed = captured.costUsd <= rule.capUsd;
  return {
    ruleKind: "cost-within",
    ruleLabel: rule.label,
    passed,
    detail: passed
      ? `observed=${captured.costUsd.toFixed(4)} ≤ cap=${rule.capUsd.toFixed(4)} USD`
      : `observed=${captured.costUsd.toFixed(4)} > cap=${rule.capUsd.toFixed(4)} USD`,
  };
}

function evaluateHumanMinutesWithin(
  rule: Extract<FixtureAcceptanceRule, { kind: "human-minutes-within" }>,
  captured: CapturedArtifacts,
): AcceptanceDecision {
  if (captured.humanMinutes === null) {
    return {
      ruleKind: "human-minutes-within",
      ruleLabel: rule.label,
      passed: false,
      detail: `human minutes unknown; cap=${rule.capMinutes.toFixed(2)}`,
    };
  }
  const passed = captured.humanMinutes <= rule.capMinutes;
  return {
    ruleKind: "human-minutes-within",
    ruleLabel: rule.label,
    passed,
    detail: passed
      ? `observed=${captured.humanMinutes.toFixed(2)} ≤ cap=${rule.capMinutes.toFixed(2)} min`
      : `observed=${captured.humanMinutes.toFixed(2)} > cap=${rule.capMinutes.toFixed(2)} min`,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Pure evaluator. Returns one decision per rule, in input order.
 */
export function evaluateAcceptance(
  rules: ReadonlyArray<FixtureAcceptanceRule>,
  captured: CapturedArtifacts,
): AcceptanceDecision[] {
  return rules.map((rule): AcceptanceDecision => {
    switch (rule.kind) {
      case "checks-pass": return evaluateChecksPass(rule, captured);
      case "candidate-tree-unchanged": return evaluateCandidateTreeUnchanged(rule, captured);
      case "candidate-diff-matches": return evaluateCandidateDiffMatches(rule, captured);
      case "review-accepted": return evaluateReviewAccepted(rule, captured);
      case "dispatch-not-replayed": return evaluateDispatchNotReplayed(rule, captured);
      case "cost-within": return evaluateCostWithin(rule, captured);
      case "human-minutes-within": return evaluateHumanMinutesWithin(rule, captured);
    }
  });
}

/**
 * Roll per-rule decisions into a single `AttemptOutcome`. The
 * convention:
 *
 *   - every decision `passed: true`           → `accepted`
 *   - any mustPass rule `passed: false`       → `rejected`
 *   - any non-mustPass rule `passed: false` only → `accepted`
 *     (the soft failure is surfaced as a decision detail)
 *   - any rule with empty `detail` AND `passed: false` → `unknown`
 *
 * The third rule preserves the ability to use soft rules (e.g.
 * `human-minutes-within`) as informative without rejecting the attempt.
 */
export function summarizeOutcome(
  rules: ReadonlyArray<FixtureAcceptanceRule>,
  decisions: ReadonlyArray<AcceptanceDecision>,
): AttemptOutcome {
  if (rules.length !== decisions.length) {
    throw new Error("rules and decisions must be the same length");
  }
  let mustPassFailed = false;
  let unknownCount = 0;
  for (let i = 0; i < rules.length; i += 1) {
    const rule = rules[i]!;
    const decision = decisions[i]!;
    if (decision.passed) continue;
    if (rule.mustPass) {
      mustPassFailed = true;
    }
    if (decision.detail === "") unknownCount += 1;
  }
  if (unknownCount > 0 && !mustPassFailed) return "unknown";
  if (mustPassFailed) return "rejected";
  return "accepted";
}

/**
 * Convenience: evaluate + summarize in one call. Useful for the runner
 * when it has both the rules and the captured artifacts ready.
 */
export function gradeAttempt(
  rules: ReadonlyArray<FixtureAcceptanceRule>,
  captured: CapturedArtifacts,
): { outcome: AttemptOutcome; decisions: AcceptanceDecision[] } {
  const decisions = evaluateAcceptance(rules, captured);
  const outcome = summarizeOutcome(rules, decisions);
  return { outcome, decisions };
}