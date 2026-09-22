/**
 * M7.4 — default-no-retry policy.
 *
 * The M7.4 spec bullet (FUTURE/IMPLEMENTATION-README.md lines 257-263)
 * requires:
 *
 *   > Default agent/arbitrary-command retries to **none**. Allow bounded
 *   > backoff only for **classified reads** or **verified idempotent
 *   > writes** with adequate dedupe horizon. Unknown effects block
 *   > successors. Stop cancels future steps; compensation is a
 *   > distinct authorized operation.
 *
 * Each workflow step declares its effect class on the RetryPolicy:
 *
 *   - `unknown` (DEFAULT) — refuse to retry at all. Even a single
 *     failure surfaces to the caller; successors do not run.
 *   - `classified-read` — same input ⇒ same output, no external
 *     state change. Allow bounded retries (2..8) with optional
 *     backoff + jitter.
 *   - `verified-idempotent-write` — the call has an idempotency key
 *     bound to a `dedupeHorizonMs` window. Allow retries within the
 *     horizon (provider-side dedup takes over).
 *
 * Refusal predicate (parse-time): `effect: "unknown"` AND
 * `maxAttempts > 1` is rejected by Zod so a malformed policy
 * fails at parse, not at runtime. This is the "unknown effects
 * block successors" gate.
 *
 * Backoff is computed from `monotonicNow()` (test seam). For
 * `jitter: "full"`, the returned delay is in
 * `[backoffMs, backoffMs * 2]`. For `jitter: "none"` it is exactly
 * `backoffMs`. Deterministic when `monotonicNow` is stubbed.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";

export const stepEffectSchema = z.enum([
  "classified-read",
  "verified-idempotent-write",
  "unknown",
]);
export type StepEffect = z.infer<typeof stepEffectSchema>;

export const retryPolicySchema = z
  .object({
    /**
     * The effect class this step is classified as. Defaults to
     * `"unknown"` (no retries allowed) for safety; callers that
     * understand their step's semantics must opt in explicitly.
     */
    effect: stepEffectSchema.default("unknown"),
    /**
     * Total attempts including the first. `1` means no retry.
     * `2..8` for classified effects. The Zod refinement below
     * rejects `> 1` when `effect: "unknown"`.
     */
    maxAttempts: z.number().int().min(1).max(8).default(1),
    /**
     * Base backoff between attempts in milliseconds. `0` ⇒
     * retry immediately. Capped at 60 s to bound tail latency.
     */
    backoffMs: z.number().int().min(0).max(60_000).default(0),
    /**
     * Jitter mode. `"none"` ⇒ deterministic (test-friendly).
     * `"full"` ⇒ uniform in `[backoffMs, 2 * backoffMs]`.
     */
    jitter: z.enum(["none", "full"]).default("none"),
    /**
     * Only honoured for `verified-idempotent-write`. Bounds the
     * dedupe horizon — a replay within the window must produce
     * the same external effect (provider guarantees this; the
     * runtime does not enforce it). `0` ⇒ no horizon guard.
     */
    dedupeHorizonMs: z.number().int().min(0).max(3_600_000).default(0),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.effect === "unknown" && value.maxAttempts > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "RetryPolicy: effect=\"unknown\" refuses retries; maxAttempts must be 1. " +
          "Classify as classified-read or verified-idempotent-write to enable retries.",
        path: ["maxAttempts"],
      });
    }
    if (value.effect !== "verified-idempotent-write" && value.dedupeHorizonMs > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "RetryPolicy: dedupeHorizonMs only applies to effect=\"verified-idempotent-write\"",
        path: ["dedupeHorizonMs"],
      });
    }
  });
export type RetryPolicy = z.output<typeof retryPolicySchema>;
export type RetryPolicyInput = z.input<typeof retryPolicySchema>;

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  effect: "unknown",
  maxAttempts: 1,
  backoffMs: 0,
  jitter: "none",
  dedupeHorizonMs: 0,
};

/** Test seam: parse a possibly-undefined value with the default fallback. */
export function parseRetryPolicy(input: RetryPolicyInput | undefined | null): RetryPolicy {
  if (input == null) return DEFAULT_RETRY_POLICY;
  return retryPolicySchema.parse(input);
}

/**
 * Classify the effect class of a step. Today the only signal we
 * have is the explicit `effect` field on the RetryPolicy; future
 * implementations could inspect step args/recipe metadata. The
 * function exists so the executor and the managed-actions seam
 * share the same classification surface.
 */
export function classifyStepEffect(policy: RetryPolicy): StepEffect {
  return policy.effect;
}

/**
 * True iff `policy` permits retries at all. Equivalent to
 * `maxAttempts > 1`, but expressed as a domain question so the
 * call sites read clearly.
 */
export function retriesAllowed(policy: RetryPolicy): boolean {
  return policy.maxAttempts > 1;
}

/**
 * Compute the backoff delay (in milliseconds) before the
 * `attempt`-th retry. `attempt` is 1-indexed: `attempt = 1`
 * returns the backoff between the first and second try.
 *
 * For `jitter: "none"` the value is exactly `backoffMs` (or 0).
 * For `jitter: "full"` the value is uniformly distributed in
 * `[backoffMs, 2 * backoffMs]`, parameterised by the supplied
 * `random01()` (test seam defaults to `Math.random`).
 *
 * The returned value is an integer millisecond count — the caller
 * converts it to `setTimeout(ms)` / `waitForMs(ms)` as appropriate.
 */
export function computeBackoff(
  policy: RetryPolicy,
  attempt: number,
  options?: {
    readonly random01?: () => number;
  },
): number {
  if (attempt < 1) {
    throw new AppError(
      "INVALID_REQUEST",
      `computeBackoff: attempt must be >= 1, got ${attempt}`,
    );
  }
  if (policy.maxAttempts <= 1) return 0;
  if (policy.backoffMs <= 0) return 0;
  const random01 = options?.random01 ?? Math.random;
  if (policy.jitter === "none") return policy.backoffMs;
  // Full jitter in [backoffMs, 2 * backoffMs]. Floor to integer ms
  // so callers can pass the value directly to setTimeout.
  const upper = 2 * policy.backoffMs;
  const sampled = policy.backoffMs + random01() * (upper - policy.backoffMs);
  return Math.max(0, Math.floor(sampled));
}

/**
 * Refuse the dispatch when the run's attempt count has already
 * met or exceeded the policy budget. Returns `null` when the
 * dispatch is admissible; returns a structured reason otherwise.
 *
 * The runner is responsible for maintaining `attempt` per step
 * (the M3b.2 invocation lineage tracks `attempt`; the M6
 * `workflow_step_state` table tracks per-step completion). This
 * helper centralises the "no retries left" check so the
 * `executeOnce` and `newAttempt` paths agree.
 */
export function checkRetryBudget(
  policy: RetryPolicy,
  attemptsSoFar: number,
): { kind: "ok" } | { kind: "exhausted"; reason: string } {
  if (attemptsSoFar < 1) {
    return {
      kind: "exhausted",
      reason: `attemptsSoFar must be >= 1, got ${attemptsSoFar}`,
    };
  }
  if (attemptsSoFar >= policy.maxAttempts) {
    return {
      kind: "exhausted",
      reason:
        `retry budget exhausted (attempted ${attemptsSoFar} of ${policy.maxAttempts}; ` +
        `policy.effect="${policy.effect}"); no further retries permitted`,
    };
  }
  return { kind: "ok" };
}
