/**
 * M3c.2 — `managed-schema` IPC payload validation tests.
 *
 * Coverage:
 *  1. `executeVerificationInputSchema` rejects a non-UUID taskId.
 *  2. `executeVerificationInputSchema` accepts a null recipeId with a
 *     command override (the one-off path).
 *  3. `executeVerificationResultSchema` round-trips an ok envelope.
 *  4. `recordReviewDecisionInputSchema` rejects `decision: "discard"`.
 *  5. `recordReviewDecisionResultSchema` round-trips a conflict.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  executeVerificationInputSchema,
  executeVerificationResultSchema,
  recordReviewDecisionInputSchema,
  recordReviewDecisionResultSchema,
} from "../../src/shared/managed-schema";

const taskId = "00000000-0000-4000-8000-000000000001";
const recipeId = "00000000-0000-4000-8000-000000000002";

test("executeVerificationInputSchema rejects a non-UUID taskId", () => {
  assert.throws(() => executeVerificationInputSchema.parse(["not-a-uuid", null, null]));
});

test("executeVerificationInputSchema accepts null recipeId with a command override", () => {
  const parsed = executeVerificationInputSchema.parse([taskId, null, { command: "echo", argv: ["hi"], env: {} }]);
  assert.equal(parsed[0], taskId);
  assert.equal(parsed[1], null);
  assert.equal(parsed[2]?.command, "echo");
});

test("executeVerificationInputSchema accepts null override (recipe-only path)", () => {
  const parsed = executeVerificationInputSchema.parse([taskId, recipeId, null]);
  assert.equal(parsed[1], recipeId);
  assert.equal(parsed[2], null);
});

test("executeVerificationResultSchema round-trips an ok envelope", () => {
  const verificationId = "00000000-0000-4000-8000-000000000003";
  const reviewId = "00000000-0000-4000-8000-000000000004";
  const parsed = executeVerificationResultSchema.parse({ kind: "ok", verificationId, reviewId });
  assert.deepEqual(parsed, { kind: "ok", verificationId, reviewId });
});

test("executeVerificationResultSchema rejects an unknown kind", () => {
  assert.throws(() => executeVerificationResultSchema.parse({ kind: "cancelled" }));
});

test("recordReviewDecisionInputSchema rejects an unknown decision", () => {
  const reviewId = "00000000-0000-4000-8000-000000000005";
  assert.throws(() => recordReviewDecisionInputSchema.parse([reviewId, "discard", "user-1"]));
});

test("recordReviewDecisionInputSchema accepts accept and reject", () => {
  const reviewId = "00000000-0000-4000-8000-000000000006";
  const accept = recordReviewDecisionInputSchema.parse([reviewId, "accept", "user-1"]);
  const reject = recordReviewDecisionInputSchema.parse([reviewId, "reject", "user-1"]);
  assert.equal(accept[1], "accept");
  assert.equal(reject[1], "reject");
});

test("recordReviewDecisionResultSchema round-trips a conflict envelope", () => {
  const parsed = recordReviewDecisionResultSchema.parse({
    kind: "conflict",
    reason: "Evidence verification 7f… is failed, not passed",
  });
  assert.equal(parsed.kind, "conflict");
  if (parsed.kind === "conflict") assert.match(parsed.reason, /not passed/);
});

test("recordReviewDecisionResultSchema rejects an unrecognised terminal status", () => {
  const reviewId = "00000000-0000-4000-8000-000000000007";
  assert.throws(() => recordReviewDecisionResultSchema.parse({ kind: "ok", reviewId, status: "queued" }));
});
