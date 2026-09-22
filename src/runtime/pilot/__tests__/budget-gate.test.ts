/**
 * M9.5 — refuse-to-spend budget gate unit tests.
 *
 * Six assertions:
 *   1. Below all caps → `ok`.
 *   2. At warn fraction of perInvocationCapUsd → `warn`.
 *   3. Above perInvocationCapUsd → `refuse`.
 *   4. perAttemptCapUsd triggers refuse even when perInvocation is below cap.
 *   5. perProfileCapUsd accumulates across attempts.
 *   6. Unknown cost (costUsd === null) → ok + unknownCost + 0 to tally.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifySpend,
  accumulateSpend,
  buildBudgetEvent,
  budgetExceededError,
} from "../budget-gate";
import type { PilotBudget } from "../../../shared/pilot-schema";

const BUDGET: PilotBudget = {
  perInvocationCapUsd: 1.0,
  perAttemptCapUsd: 2.0,
  perProfileCapUsd: 5.0,
  warnAtFraction: 0.8,
};

test("classifySpend returns 'ok' when below all caps", () => {
  const result = classifySpend({
    observed: { costUsd: 0.25 },
    state: { attemptSpentUsd: 0, profileSpentUsd: 0 },
    budget: BUDGET,
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.unknownCost, false);
});

test("classifySpend returns 'warn' at 80% of perInvocationCapUsd", () => {
  // 0.85 USD > 0.8 × 1.0 USD perInvocationCapWarn.
  const result = classifySpend({
    observed: { costUsd: 0.85 },
    state: { attemptSpentUsd: 0, profileSpentUsd: 0 },
    budget: BUDGET,
  });
  assert.equal(result.kind, "warn");
  assert.equal(result.cap, "perInvocationCapUsd");
  assert.equal(result.capUsd, 1.0);
  assert.equal(result.observedUsd, 0.85);
});

test("classifySpend returns 'refuse' at 100% of perInvocationCapUsd", () => {
  const result = classifySpend({
    observed: { costUsd: 1.5 },
    state: { attemptSpentUsd: 0, profileSpentUsd: 0 },
    budget: BUDGET,
  });
  assert.equal(result.kind, "refuse");
  assert.equal(result.cap, "perInvocationCapUsd");
  assert.equal(result.reason.includes("perInvocationCapUsd"), true);
  // The error helper produces an AppError with BUDGET_EXCEEDED.
  const err = budgetExceededError(result);
  assert.equal(err.failure.code, "BUDGET_EXCEEDED");
  assert.equal(err.failure.retryable, false);
});

test("perAttemptCapUsd triggers refuse even when perInvocation is below cap", () => {
  // Single invocation is 0.5 USD (below 1.0 cap), but cumulative attempt is
  // 1.6 USD + 0.5 USD = 2.1 USD, which exceeds the 2.0 perAttemptCapUsd.
  const result = classifySpend({
    observed: { costUsd: 0.5 },
    state: { attemptSpentUsd: 1.6, profileSpentUsd: 1.6 },
    budget: BUDGET,
  });
  assert.equal(result.kind, "refuse");
  assert.equal(result.cap, "perAttemptCapUsd");
  // The buildBudgetEvent helper turns it into a structured event.
  const evt = buildBudgetEvent({
    classification: result,
    participantId: "alice",
    attemptId: "11111111-1111-4111-8111-111111111111",
    at: new Date().toISOString(),
  });
  assert.equal(evt.kind, "refuse");
  assert.equal(evt.cap, "perAttemptCapUsd");
  assert.equal(evt.participantId, "alice");
});

test("perProfileCapUsd accumulates across attempts", () => {
  // First call: 0.5 USD + 3.0 USD profile = 3.5 USD; well below 80% of 5.0
  // USD profile cap (warn at 4.0 USD). Below warn → ok.
  const first = classifySpend({
    observed: { costUsd: 0.5 },
    state: { attemptSpentUsd: 1.0, profileSpentUsd: 3.0 },
    budget: BUDGET,
  });
  assert.equal(first.kind, "ok", "first call is under profile cap");
  const accumulated = accumulateSpend({ attemptSpentUsd: 1.0, profileSpentUsd: 3.0 }, { costUsd: 0.5 });
  assert.equal(accumulated.attemptSpentUsd, 1.5);
  assert.equal(accumulated.profileSpentUsd, 3.5);
  // Next call: profileSpentUsd 4.9 USD + 0.5 USD = 5.4 USD → refuse.
  const second = classifySpend({
    observed: { costUsd: 0.5 },
    state: { attemptSpentUsd: 0, profileSpentUsd: 4.9 },
    budget: BUDGET,
  });
  assert.equal(second.kind, "refuse");
  assert.equal(second.cap, "perProfileCapUsd");
});

test("unknownCost (costUsd === null) contributes 0 to tally and sets unknownCost: true", () => {
  const result = classifySpend({
    observed: { costUsd: null },
    state: { attemptSpentUsd: 4.0, profileSpentUsd: 4.0 },
    budget: BUDGET,
  });
  assert.equal(result.kind, "ok");
  assert.equal(result.unknownCost, true);
  // accumulateSpend leaves the state unchanged.
  const after = accumulateSpend({ attemptSpentUsd: 4.0, profileSpentUsd: 4.0 }, { costUsd: null });
  assert.equal(after.attemptSpentUsd, 4.0);
  assert.equal(after.profileSpentUsd, 4.0);
});