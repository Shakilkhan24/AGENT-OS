/**
 * M9.5 — grader unit tests.
 *
 * Five assertions covering the public evaluator:
 *   1. All rules pass → `accepted`.
 *   2. One rule fails → `rejected`.
 *   3. `cost-within` rule reports cap and observed in the detail.
 *   4. `candidate-diff-matches` rejects on sha256 mismatch.
 *   5. `dispatch-not-replayed` rejects when reference invocations are missing or duplicated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateAcceptance,
  gradeAttempt,
  summarizeOutcome,
  type CapturedArtifacts,
} from "../grader";
import type { FixtureAcceptanceRule } from "../../../shared/pilot-schema";

const BASE_CAPTURED: CapturedArtifacts = {
  checkResults: [{ name: "lint", status: "passed", detail: "ok" }],
  candidateTreeSha256: "a".repeat(64),
  candidateDiffSha256: "b".repeat(64),
  reviewStatus: "accepted",
  observedInvocationIds: ["11111111-1111-4111-8111-111111111111"],
  costUsd: 0.25,
  humanMinutes: 12,
};

function ruleOf(r: FixtureAcceptanceRule): FixtureAcceptanceRule {
  return r;
}

test("evaluateAcceptance returns 'accepted' when all rules pass", () => {
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "checks-pass", label: "lint-required", description: "", mustPass: true,
      requiredCheckNames: ["lint"] }),
    ruleOf({ kind: "review-accepted", label: "review-required", description: "", mustPass: true,
      requiredStatus: "accepted" }),
    ruleOf({ kind: "cost-within", label: "cost-cap", description: "", mustPass: true,
      capUsd: 1.0 }),
  ];
  const { outcome, decisions } = gradeAttempt(rules, BASE_CAPTURED);
  assert.equal(outcome, "accepted");
  assert.equal(decisions.length, 3);
  for (const d of decisions) assert.equal(d.passed, true);
});

test("evaluateAcceptance returns 'rejected' when one rule fails", () => {
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "checks-pass", label: "lint-required", description: "", mustPass: true,
      requiredCheckNames: ["lint"] }),
    ruleOf({ kind: "review-accepted", label: "review-required", description: "", mustPass: true,
      requiredStatus: "accepted" }),
    // Missing review is fatal here.
    ruleOf({ kind: "human-minutes-within", label: "soft-human-minutes", description: "", mustPass: true,
      capMinutes: 5 }),
  ];
  // BASE_CAPTURED has humanMinutes=12 > 5.
  const { outcome, decisions } = gradeAttempt(rules, BASE_CAPTURED);
  assert.equal(outcome, "rejected");
  assert.equal(decisions[2]!.passed, false);
});

test("cost-within rule reports cap and observed", () => {
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "cost-within", label: "cost-cap", description: "", mustPass: true,
      capUsd: 0.10 }),
  ];
  const decisions = evaluateAcceptance(rules, BASE_CAPTURED);
  const decision = decisions[0]!;
  assert.equal(decision.passed, false);
  assert.ok(decision.detail.includes("0.2500"), `detail should report observed: ${decision.detail}`);
  assert.ok(decision.detail.includes("0.1000"), `detail should report cap: ${decision.detail}`);
});

test("candidate-diff-matches rule compares sha256 and rejects on mismatch", () => {
  const expectedSha = "c".repeat(64);
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "candidate-diff-matches", label: "diff-matches", description: "", mustPass: true,
      expectedSha256: expectedSha }),
  ];
  // BASE_CAPTURED.candidateDiffSha256 = "bbbb..." ≠ "cccc...".
  const decisions = evaluateAcceptance(rules, BASE_CAPTURED);
  assert.equal(decisions[0]!.passed, false);
  // Now match.
  const matched = { ...BASE_CAPTURED, candidateDiffSha256: expectedSha };
  const matchedDecisions = evaluateAcceptance(rules, matched);
  assert.equal(matchedDecisions[0]!.passed, true);
});

test("dispatch-not-replayed rejects when reference invocationId set is incomplete or duplicated", () => {
  const ref = "11111111-1111-4111-8111-111111111111";
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "dispatch-not-replayed", label: "one-shot", description: "", mustPass: true,
      referenceInvocationIds: [ref] }),
  ];
  // Missing reference invocation.
  const missing: CapturedArtifacts = { ...BASE_CAPTURED, observedInvocationIds: [] };
  const missingDecisions = evaluateAcceptance(rules, missing);
  assert.equal(missingDecisions[0]!.passed, false);
  assert.ok(missingDecisions[0]!.detail.includes("missing reference invocations"));

  // Duplicated reference invocation.
  const duplicated: CapturedArtifacts = { ...BASE_CAPTURED, observedInvocationIds: [ref, ref] };
  const dupDecisions = evaluateAcceptance(rules, duplicated);
  assert.equal(dupDecisions[0]!.passed, false);
  assert.ok(dupDecisions[0]!.detail.includes("more or fewer than once"));

  // Exactly once.
  const ok: CapturedArtifacts = { ...BASE_CAPTURED, observedInvocationIds: [ref] };
  const okDecisions = evaluateAcceptance(rules, ok);
  assert.equal(okDecisions[0]!.passed, true);
});

// Bonus: summarizeOutcome treats soft failures as accepted when no mustPass rule fails.
test("summarizeOutcome treats soft failures as accepted when no mustPass rule fails", () => {
  const rules: FixtureAcceptanceRule[] = [
    ruleOf({ kind: "cost-within", label: "soft", description: "", mustPass: false,
      capUsd: 0.10 }),
    ruleOf({ kind: "checks-pass", label: "hard", description: "", mustPass: true,
      requiredCheckNames: ["lint"] }),
  ];
  const decisions = evaluateAcceptance(rules, BASE_CAPTURED);
  const outcome = summarizeOutcome(rules, decisions);
  assert.equal(outcome, "accepted", "soft cost-within failure does not reject when mustPass lint passed");
});