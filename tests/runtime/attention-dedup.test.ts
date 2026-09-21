/**
 * M7.7 — schedule-decision + ci-failure attention rows with stable-key dedup.
 *
 * The M7.7 spec bullet requires:
 *
 *   > Schedule/CI decisions enter the existing attention inbox.
 *   > Detect repeated failures without creating an alert flood.
 *   > Expose disable / inspect / stop / reconcile / deliberate retry
 *   > separately. Preserve a quiet mode and unresolved decisions.
 *
 * Coverage:
 *
 *   1. Same (kind, issueIdentity) raised twice within window → second is
 *      a no-op (no new row, returns existing).
 *   2. Same (kind, issueIdentity) raised twice outside the window →
 *      new row.
 *   3. Different kind or different payload → independent rows.
 *   4. `schedule-decision` payload schema rejects malformed inputs.
 *   5. `ci-failure` payload schema rejects malformed inputs.
 *   6. `answerAttention` accepts `kind: "schedule-decision"` (M7.7 widens).
 *   7. `answerAttention` rejects `kind: "ci-failure"` (separate path).
 *   8. The existing FSM transitions work for new kinds (no special casing).
 *   9. `shouldSuppressAttention` ignores `dismissed` / `resolved` rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  ciFailurePayloadSchema,
  DEFAULT_ATTENTION_DEDUP_WINDOW_MS,
  raiseCiFailure,
  raiseScheduleDecision,
  scheduleDecisionPayloadSchema,
  shouldSuppressAttention,
  transitionAttention,
} from "../../src/runtime/db/attention-items";
import { answerAttention } from "../../src/runtime/orchestration/managed-actions";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const SCHEDULE_PAYLOAD = {
  scheduleId: "sched-1",
  revision: 1,
  intendedUtc: "2026-01-01T09:00:00.000Z",
  kind: "missed" as const,
  recipeId: "r-1",
};

const CI_PAYLOAD = {
  artifactSha256: "a".repeat(64),
  buildId: "build-1",
  commitSha: "deadbeef",
  workflowRunId: "wf-1",
  attemptCount: 3,
  lastErrorDigest: "fail-1",
  retryBudgetExhausted: false,
};

test("M7.7 same (kind, identity) raised twice within window → second is a no-op", async () => {
  const worker = freshWorker();
  try {
    const first = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    assert.equal(first.kind, "created");
    const second = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    assert.equal(second.kind, "suppressed");
    assert.equal(second.item.id, first.item.id);
    assert.equal(second.issueIdentity, first.issueIdentity);
  } finally { await worker.close(); }
});

test("M7.7 same (kind, identity) raised twice outside the window → new row", async () => {
  const worker = freshWorker();
  try {
    const first = await raiseScheduleDecision(worker, {
      payload: SCHEDULE_PAYLOAD,
      now: new Date("2026-01-01T00:00:00Z"),
    });
    const second = await raiseScheduleDecision(worker, {
      payload: SCHEDULE_PAYLOAD,
      now: new Date("2026-01-02T00:00:00Z"), // 24h later, well past 1h window
    });
    assert.equal(second.kind, "created");
    assert.notEqual(second.item.id, first.item.id);
  } finally { await worker.close(); }
});

test("M7.7 different kind → independent rows", async () => {
  const worker = freshWorker();
  try {
    const a = await raiseScheduleDecision(worker, {
      payload: { ...SCHEDULE_PAYLOAD, kind: "missed" },
    });
    const b = await raiseScheduleDecision(worker, {
      payload: { ...SCHEDULE_PAYLOAD, kind: "overlap", intendedUtc: "2026-01-01T10:00:00.000Z" },
    });
    assert.equal(a.kind, "created");
    assert.equal(b.kind, "created");
    assert.notEqual(a.item.id, b.item.id);
  } finally { await worker.close(); }
});

test("M7.7 different identity (different scheduleId) → independent rows", async () => {
  const worker = freshWorker();
  try {
    const a = await raiseScheduleDecision(worker, {
      payload: { ...SCHEDULE_PAYLOAD, scheduleId: "sched-1" },
    });
    const b = await raiseScheduleDecision(worker, {
      payload: { ...SCHEDULE_PAYLOAD, scheduleId: "sched-2" },
    });
    assert.equal(a.kind, "created");
    assert.equal(b.kind, "created");
    assert.notEqual(a.item.id, b.item.id);
  } finally { await worker.close(); }
});

test("M7.7 ci-failure dedup: same digest within window → suppressed", async () => {
  const worker = freshWorker();
  try {
    const first = await raiseCiFailure(worker, { payload: CI_PAYLOAD });
    assert.equal(first.kind, "created");
    const second = await raiseCiFailure(worker, { payload: CI_PAYLOAD });
    assert.equal(second.kind, "suppressed");
    assert.equal(second.item.id, first.item.id);
  } finally { await worker.close(); }
});

test("M7.7 ci-failure with retryBudgetExhausted=true is a distinct identity", async () => {
  const worker = freshWorker();
  try {
    const a = await raiseCiFailure(worker, { payload: { ...CI_PAYLOAD, retryBudgetExhausted: false } });
    const b = await raiseCiFailure(worker, { payload: { ...CI_PAYLOAD, retryBudgetExhausted: true } });
    assert.equal(a.kind, "created");
    assert.equal(b.kind, "created");
    assert.notEqual(a.item.id, b.item.id);
  } finally { await worker.close(); }
});

test("M7.7 scheduleDecisionPayloadSchema rejects malformed inputs", () => {
  // kind outside the enum
  assert.throws(() => scheduleDecisionPayloadSchema.parse({
    ...SCHEDULE_PAYLOAD, kind: "unknown-reason",
  }));
  // scheduleId empty
  assert.throws(() => scheduleDecisionPayloadSchema.parse({ ...SCHEDULE_PAYLOAD, scheduleId: "" }));
  // intendedUtc not a datetime
  assert.throws(() => scheduleDecisionPayloadSchema.parse({ ...SCHEDULE_PAYLOAD, intendedUtc: "yesterday" }));
  // happy path
  const ok = scheduleDecisionPayloadSchema.parse(SCHEDULE_PAYLOAD);
  assert.equal(ok.scheduleId, "sched-1");
});

test("M7.7 ciFailurePayloadSchema rejects malformed inputs", () => {
  // artifactSha256 not 64-hex
  assert.throws(() => ciFailurePayloadSchema.parse({ ...CI_PAYLOAD, artifactSha256: "short" }));
  // attemptCount negative
  assert.throws(() => ciFailurePayloadSchema.parse({ ...CI_PAYLOAD, attemptCount: -1 }));
  // commitSha not hex
  assert.throws(() => ciFailurePayloadSchema.parse({ ...CI_PAYLOAD, commitSha: "ZZZ" }));
  // happy path
  const ok = ciFailurePayloadSchema.parse(CI_PAYLOAD);
  assert.equal(ok.attemptCount, 3);
});

test("M7.7 answerAttention accepts schedule-decision (kind-agnostic answer)", async () => {
  const worker = freshWorker();
  try {
    const raised = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    // Move to `seen` first (FSM widens from new → seen).
    await transitionAttention(worker, raised.item.id, "seen");
    const answer = await answerAttention(worker, raised.item.id, {
      reply: "disable the schedule",
      answeredBy: "operator-1",
    });
    assert.equal(answer.kind, "ok");
    assert.equal(answer.resolvedItem.kind, "schedule-decision");
    assert.ok(answer.followUpItem, "followUpItem should be present");
    // M7.7 — the follow-up row preserves the kind so the inbox can
    // continue to surface schedule-decisions (not collapse them into
    // generic `decision` entries).
    assert.equal(answer.followUpItem?.kind, "schedule-decision");
    assert.equal(answer.followUpItem?.revision, raised.item.revision + 1);
  } finally { await worker.close(); }
});

test("M7.7 answerAttention rejects ci-failure (different surface)", async () => {
  const worker = freshWorker();
  try {
    const raised = await raiseCiFailure(worker, { payload: CI_PAYLOAD });
    await assert.rejects(
      () => answerAttention(worker, raised.item.id, {
        reply: "retry",
        answeredBy: "operator-1",
      }),
      (e: unknown) => {
        // AppError exposes the failure code on `failure.code` and the
        // message on `message`. Both must reflect the kind refusal.
        const maybe = e as { failure?: { code?: string }; message?: string };
        const code = maybe?.failure?.code ?? "";
        const message = maybe?.message ?? "";
        return code === "CONFLICT" && message.includes("ci-failure");
      },
    );
  } finally { await worker.close(); }
});

test("M7.7 FSM transitions work for new kinds (no special-casing)", async () => {
  const worker = freshWorker();
  try {
    const raised = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    const seen = await transitionAttention(worker, raised.item.id, "seen");
    assert.equal(seen.state, "seen");
    const snoozed = await transitionAttention(worker, raised.item.id, "snoozed");
    assert.equal(snoozed.state, "snoozed");
    const resolved = await transitionAttention(worker, raised.item.id, "resolved");
    assert.equal(resolved.state, "resolved");
  } finally { await worker.close(); }
});

test("M7.7 shouldSuppressAttention ignores dismissed + resolved rows", async () => {
  const worker = freshWorker();
  try {
    const first = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    // Resolve it. The next raise should NOT be suppressed (resolved
    // rows do not count toward the dedup window).
    await transitionAttention(worker, first.item.id, "resolved");
    const next = await raiseScheduleDecision(worker, { payload: SCHEDULE_PAYLOAD });
    assert.equal(next.kind, "created");
    assert.notEqual(next.item.id, first.item.id);
  } finally { await worker.close(); }
});

test("M7.7 shouldSuppressAttention returns null when no row matches", async () => {
  const worker = freshWorker();
  try {
    const result = shouldSuppressAttention(worker, "schedule-decision", "nonexistent");
    assert.equal(result, null);
  } finally { await worker.close(); }
});

test("M7.7 default dedup window is 1 hour", () => {
  assert.equal(DEFAULT_ATTENTION_DEDUP_WINDOW_MS, 60 * 60_000);
});
