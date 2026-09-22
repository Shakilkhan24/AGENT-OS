/**
 * M7.4 — default-no-retry policy tests.
 *
 * The M7.4 spec bullet (FUTURE/IMPLEMENTATION-README.md lines 257-263)
 * requires:
 *
 *   - default agent/arbitrary-command retries to **none**;
 *   - allow bounded backoff only for classified reads or verified
 *     idempotent writes with adequate dedupe horizon;
 *   - unknown effects block successors;
 *   - stop cancels future steps; compensation is distinct.
 *
 * Coverage:
 *
 *   1. omit `retryPolicy` ⇒ 1 attempt, no backoff (default-no);
 *   2. classified-read retry: 3 attempts at fixed backoff; attempt 3 hits the budget;
 *   3. verified-idempotent-write: dedupe horizon enforced; parsed at default 0;
 *   4. unknown effect rejects `maxAttempts > 1` at parse time;
 *   5. jitter math is bounded `[backoffMs, 2 * backoffMs]` for `jitter: "full"`;
 *   6. `checkRetryBudget` refuses exhausted budgets;
 *   7. `retryPolicySchema` defaults populate correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  DEFAULT_RETRY_POLICY,
  checkRetryBudget,
  classifyStepEffect,
  computeBackoff,
  parseRetryPolicy,
  retriesAllowed,
  retryPolicySchema,
  stepEffectSchema,
} from "../../src/runtime/orchestration/retry-policy";

test("M7.4 default-no-retry: omit retryPolicy ⇒ 1 attempt, no backoff", () => {
  const policy = parseRetryPolicy(undefined);
  assert.deepEqual(policy, {
    effect: "unknown",
    maxAttempts: 1,
    backoffMs: 0,
    jitter: "none",
    dedupeHorizonMs: 0,
  });
  assert.equal(policy.effect, "unknown");
  assert.equal(policy.maxAttempts, 1);
  assert.equal(policy.backoffMs, 0);
  assert.equal(retriesAllowed(policy), false);
  assert.equal(computeBackoff(policy, 1), 0);
});

test("M7.4 classified-read retry: 3 attempts at fixed backoff, 3rd hits budget", () => {
  const policy = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 3,
    backoffMs: 1_000,
    jitter: "none",
  });
  assert.equal(classifyStepEffect(policy), "classified-read");
  assert.equal(policy.maxAttempts, 3);
  assert.equal(computeBackoff(policy, 1), 1_000);
  assert.equal(computeBackoff(policy, 2), 1_000);
  assert.equal(retriesAllowed(policy), true);
  // Budget check — 3 attempts allowed, the 3rd attempt hits the budget.
  assert.deepEqual(checkRetryBudget(policy, 1), { kind: "ok" });
  assert.deepEqual(checkRetryBudget(policy, 2), { kind: "ok" });
  const exhausted = checkRetryBudget(policy, 3);
  assert.equal(exhausted.kind, "exhausted");
  if (exhausted.kind === "exhausted") {
    assert.match(exhausted.reason, /attempted 3 of 3/);
  }
});

test("M7.4 verified-idempotent-write: dedupe horizon enforced; default 0", () => {
  const policy = retryPolicySchema.parse({
    effect: "verified-idempotent-write",
    maxAttempts: 4,
    backoffMs: 250,
    dedupeHorizonMs: 5 * 60_000,
  });
  assert.equal(policy.dedupeHorizonMs, 5 * 60_000);
  assert.equal(computeBackoff(policy, 1), 250);
  // Setting dedupeHorizonMs on a non-idempotent effect is refused.
  assert.throws(
    () => retryPolicySchema.parse({
      effect: "classified-read",
      maxAttempts: 2,
      dedupeHorizonMs: 60_000,
    }),
    (e: unknown) => e instanceof z.ZodError,
  );
});

test("M7.4 unknown effect rejects maxAttempts > 1 at parse time", () => {
  // The Zod refinement rejects `effect: "unknown" + maxAttempts > 1`.
  assert.throws(
    () => retryPolicySchema.parse({
      effect: "unknown",
      maxAttempts: 3,
    }),
    (e: unknown) => {
      if (!(e instanceof z.ZodError)) return false;
      return e.issues.some((i) => i.path.includes("maxAttempts"));
    },
  );
  // And the same with backoff > 0 also rejected.
  assert.throws(
    () => retryPolicySchema.parse({
      effect: "unknown",
      maxAttempts: 2,
      backoffMs: 500,
    }),
    (e: unknown) => e instanceof z.ZodError,
  );
});

test("M7.4 jitter: full is bounded [backoffMs, 2 * backoffMs]", () => {
  const policy = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 3,
    backoffMs: 1_000,
    jitter: "full",
  });
  // Sample 100 times with random01 = 0 ⇒ floor(lower bound).
  assert.equal(computeBackoff(policy, 1, { random01: () => 0 }), 1_000);
  // random01 = 1 ⇒ upper bound (sampled = 1000 + 1.0 * 1000 = 2000).
  assert.equal(computeBackoff(policy, 1, { random01: () => 1 }), 2_000);
  // Mid-range ⇒ bounded.
  for (let i = 0; i < 50; i++) {
    const v = computeBackoff(policy, 1, { random01: Math.random });
    assert.ok(v >= 1_000 && v <= 2_000, `out of bounds: ${v}`);
  }
});

test("M7.4 jitter: none is deterministic", () => {
  const policy = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 2,
    backoffMs: 750,
    jitter: "none",
  });
  // Three consecutive samples are equal (no random component).
  assert.equal(computeBackoff(policy, 1), 750);
  assert.equal(computeBackoff(policy, 1), 750);
  assert.equal(computeBackoff(policy, 2), 750);
});

test("M7.4 checkRetryBudget: refuses exhausted budgets and bogus attempt counts", () => {
  const policy = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 2,
    backoffMs: 100,
  });
  // attemptsSoFar must be >= 1 (sentinel for "first try still pending").
  const bogus = checkRetryBudget(policy, 0);
  assert.equal(bogus.kind, "exhausted");
  // After one attempt, one more is allowed.
  assert.deepEqual(checkRetryBudget(policy, 1), { kind: "ok" });
  // After the second attempt, no more retries.
  const exhausted = checkRetryBudget(policy, 2);
  assert.equal(exhausted.kind, "exhausted");
});

test("M7.4 DEFAULT_RETRY_POLICY is the unknown no-retry policy", () => {
  assert.equal(DEFAULT_RETRY_POLICY.effect, "unknown");
  assert.equal(DEFAULT_RETRY_POLICY.maxAttempts, 1);
  assert.equal(DEFAULT_RETRY_POLICY.backoffMs, 0);
  assert.equal(DEFAULT_RETRY_POLICY.jitter, "none");
  assert.equal(DEFAULT_RETRY_POLICY.dedupeHorizonMs, 0);
});

test("M7.4 stepEffectSchema covers the three classes", () => {
  // Schema accepts the three documented effect classes.
  expectEffect("classified-read");
  expectEffect("verified-idempotent-write");
  expectEffect("unknown");
  // Refuses anything else.
  assert.throws(() => stepEffectSchema.parse("side-effect"), (e: unknown) => e instanceof z.ZodError);
  function expectEffect(v: string) {
    assert.equal(stepEffectSchema.parse(v), v);
  }
});

test("M7.4 computeBackoff with backoffMs = 0 returns 0 regardless of jitter", () => {
  const noJitter = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 4,
    backoffMs: 0,
    jitter: "none",
  });
  assert.equal(computeBackoff(noJitter, 1), 0);
  const fullJitter = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 4,
    backoffMs: 0,
    jitter: "full",
  });
  assert.equal(computeBackoff(fullJitter, 1, { random01: () => 0.5 }), 0);
});

test("M7.4 computeBackoff rejects attempt < 1", () => {
  const policy = retryPolicySchema.parse({
    effect: "classified-read",
    maxAttempts: 2,
    backoffMs: 100,
  });
  assert.throws(
    () => computeBackoff(policy, 0),
    (e: unknown) => e instanceof Error && e.message.includes("attempt must be >= 1"),
  );
});

test("M7.4 retryPolicySchema defaults populate correctly via .parse({})", () => {
  const policy = retryPolicySchema.parse({});
  assert.deepEqual(policy, {
    effect: "unknown",
    maxAttempts: 1,
    backoffMs: 0,
    jitter: "none",
    dedupeHorizonMs: 0,
  });
});

test("M7.4 retryPolicySchema rejects unknown fields (strict)", () => {
  assert.throws(
    () => retryPolicySchema.parse({
      effect: "unknown",
      maxAttempts: 1,
      notAField: 42,
    }),
    (e: unknown) => e instanceof z.ZodError,
  );
});
