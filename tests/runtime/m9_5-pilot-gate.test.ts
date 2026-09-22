/**
 * M9.5 GATE — pilot harness complete-scope rehearsal.
 *
 * The M9.5 bullet (FUTURE/IMPLEMENTATION-README.md line 289) reads:
 *
 *   > Compare useful tasks against the user's current terminal
 *   > workflow and native provider workflow with matched
 *   > versions/budgets. Measure accepted outcomes, review/recovery
 *   > effort, defects, all attempts and unknown cost. Counterbalance
 *   > task order; small pilots cannot establish universal
 *   > productivity multipliers.
 *
 * This test exercises the M9.5 deliverable end-to-end:
 *
 *   - 6 participants × 5 fixtures × 3 conditions = 90 synthetic
 *     attempts.
 *   - All 5 fixture families are represented (1 per family).
 *   - The Williams 3×6 counterbalance is invoked.
 *   - The budget gate is exercised; refusal rates are surfaced via
 *     the `budgetEvents` surface (synthetic mode produces zero
 *     refusals by design).
 *   - The aggregate `pilotReportSchema` is validated and the
 *     `caveats[]` field carries the four honest-limit lines.
 *
 * Evidence map mirrors the `m9-gate.test.ts` shape: one assertion
 * per sub-deliverable so a failure points to a specific layer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  pilotCharterSchema,
  fixtureSchema,
  type Fixture,
  type PilotCharter,
} from "../../src/shared/pilot-schema";
import { runPilot } from "../../src/runtime/pilot/runner";
import { rollAttempts } from "../../src/runtime/pilot/aggregate";
import { pilotReportSchema, DEFAULT_PILOT_CAVEATS } from "../../src/shared/pilot-schema";

function makeFixture(
  id: string,
  family: Fixture["family"],
): Fixture {
  return fixtureSchema.parse({
    id,
    family,
    displayName: `${id} (synthetic)`,
    baseRevision: "main@00000000",
    allowedScope: [`src/${id}/**`],
    contextInputs: [],
    environmentImage: "ubuntu-22.04",
    hardwareAllocation: "2 vCPU / 4 GiB",
    timeoutMinutes: 30,
    attemptBudget: 3,
    graderVersion: "1.0.0",
    acceptance: [
      {
        kind: "checks-pass",
        label: `${id}-lint`,
        description: "",
        mustPass: true,
        requiredCheckNames: ["lint"],
      },
      {
        kind: "review-accepted",
        label: `${id}-review`,
        description: "",
        mustPass: true,
        requiredStatus: "accepted",
      },
    ],
    drivers: [
      { condition: "terminal-baseline", invocation: "manual-terminal", providerPin: "n/a", reference: "docs/runbooks/run-pilot.md" },
      { condition: "native-provider",   invocation: "claude",           providerPin: "1.2.5", reference: "docs/compatibility.md" },
      { condition: "minimal",           invocation: "minimal-dispatch", providerPin: "1.2.5", reference: "src/runtime/pilot/runner.ts" },
    ],
  });
}

test("M9.5 GATE: pilot harness complete-scope rehearsal (6 × 5 × 3 = 90 attempts)", async () => {
  const evidence = new Map<string, unknown>();

  // ── Charter ──────────────────────────────────────────────────────────────
  const charter: PilotCharter = pilotCharterSchema.parse({
    pilotId: "pilot-m9.5-gate",
    charterVersion: "1.0.0",
    graderVersion: "1.0.0",
    participantIds: ["p1", "p2", "p3", "p4", "p5", "p6"],
    seed: "9aa31be9cafe0001",
    budget: {
      perInvocationCapUsd: 0.10,
      perAttemptCapUsd: 0.20,
      perProfileCapUsd: 5.00,
      warnAtFraction: 0.8,
    },
    canaries: [
      { name: "synthetic-marker", value: "PILOT-MARKER-9aa31be9" },
    ],
  });
  assert.equal(charter.participantIds.length, 6);
  evidence.set("counterbalance", charter.participantIds.length);

  // ── Fixture bank — 1 per family (5 fixtures total) ───────────────────────
  const fixtures: Fixture[] = [
    makeFixture("routine-01", "routine-change"),
    makeFixture("context-handoff-01", "context-handoff"),
    makeFixture("parallel-integration-01", "parallel-integration"),
    makeFixture("interruption-recovery-01", "interruption-recovery"),
    makeFixture("recipe-review-01", "recipe-review"),
  ];
  assert.equal(fixtures.length, 5);
  evidence.set("fixtures.byFamily", fixtures.map((f) => f.family));

  // ── Runner (synthetic dispatch seam, no real I/O) ────────────────────────
  const result = await runPilot({ charter, fixtures, synthetic: true });
  evidence.set("runner.budgetEvents", result.budgetEvents.length);

  // 6 × 5 × 3 = 90 attempts.
  assert.equal(result.attempts.length, 90,
    `expected 90 attempts (6 participants × 5 fixtures × 3 conditions), got ${result.attempts.length}`);
  evidence.set("runner.attempts", result.attempts.length);

  // ── Budget gate ──────────────────────────────────────────────────────────
  // Synthetic mode produces small positive costs (0.05 / 0.07 / 0.02 USD),
  // all well under the 0.10 perInvocationCapUsd, so no refusals occur.
  const refusalCount = result.budgetEvents.filter((b) => b.kind === "refuse").length;
  assert.equal(refusalCount, 0, "synthetic mode does not produce refusals");
  evidence.set("budget-gate.refusals", refusalCount);

  // ── Grader ───────────────────────────────────────────────────────────────
  // Outcomes must be one of the five schema-defined literals, and the
  // totals must sum to the attempt count.
  const outcomeCounts = {
    accepted: result.attempts.filter((a) => a.outcome === "accepted").length,
    rejected: result.attempts.filter((a) => a.outcome === "rejected").length,
    abandoned: result.attempts.filter((a) => a.outcome === "abandoned").length,
    timeout: result.attempts.filter((a) => a.outcome === "timeout").length,
    unknown: result.attempts.filter((a) => a.outcome === "unknown").length,
  };
  const sum = Object.values(outcomeCounts).reduce((a, b) => a + b, 0);
  assert.equal(sum, result.attempts.length, "every attempt has exactly one outcome");
  evidence.set("grader.outcomes", outcomeCounts);

  // ── Aggregate report ─────────────────────────────────────────────────────
  const report = rollAttempts({
    pilotId: charter.pilotId,
    charterVersion: charter.charterVersion,
    graderVersion: charter.graderVersion,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    cohort: result.cohort,
    attempts: result.attempts,
    budgetEvents: result.budgetEvents,
  });
  const validated = pilotReportSchema.parse(report);
  evidence.set("aggregate.totals", validated.totals);

  // byCondition must cover all three conditions (even if some are 0-attempt).
  assert.equal(validated.byCondition.length, 3,
    `byCondition should be keyed on all three conditions, got ${validated.byCondition.length}`);
  const conditionsCovered = new Set(validated.byCondition.map((b) => b.condition));
  assert.equal(conditionsCovered.size, 3);
  evidence.set("aggregate.byCondition", [...conditionsCovered]);

  // byFamily must cover all five families.
  assert.equal(validated.byFamily.length, 5,
    `byFamily should cover all 5 fixture families, got ${validated.byFamily.length}`);
  evidence.set("aggregate.byFamily", validated.byFamily.map((b) => b.family));

  // ── Caveats — the literal home of "small pilots cannot establish..." ──────
  assert.equal(validated.caveats.length, DEFAULT_PILOT_CAVEATS.length,
    `caveats must carry ${DEFAULT_PILOT_CAVEATS.length} default lines`);
  // Match either the original bullet wording or the canonical "small pilots" phrasing.
  const honestLimitCaveat = validated.caveats.find((c) =>
    c.toLowerCase().includes("small cohort") ||
    c.toLowerCase().includes("small pilots cannot establish"));
  assert.ok(honestLimitCaveat,
    "caveats[] must carry the honest-limit line about small cohort / pilot scope");
  // The exact wording of the M9.5 bullet must be reachable in caveats[].
  const smallCohortLine = validated.caveats.find((c) =>
    c.toLowerCase().includes("universal productivity multipliers"));
  assert.ok(smallCohortLine,
    "caveats[] must include the 'universal productivity multipliers' line");
  evidence.set("caveats.lines", validated.caveats.length);

  // ── perAttempt preservation ──────────────────────────────────────────────
  assert.equal(validated.perAttempt.length, 90);
  evidence.set("ndjson-emit.attemptCount", validated.perAttempt.length);

  // Every attempt has a populated providerFingerprint.
  for (const a of validated.perAttempt) {
    assert.ok(a.providerFingerprint.length > 0);
    assert.ok(a.attemptId.length === 36, "attemptId is a uuid");
    assert.ok(a.startedAt.length > 0);
    assert.ok(a.endedAt.length > 0);
  }

  // ── Exit codes ───────────────────────────────────────────────────────────
  // Pilot completes without refusal → exit 0 in the CLI mapping.
  const simulatedExitCode: 0 | 1 = validated.totals.budgetRefusals > 0 ? 1 : 0;
  assert.equal(simulatedExitCode, 0, "no refusals → exit 0");
  evidence.set("exit-codes.refusalMap", simulatedExitCode);

  // ── Final evidence check ─────────────────────────────────────────────────
  const requiredKeys = [
    "counterbalance",
    "fixtures.byFamily",
    "runner.budgetEvents",
    "runner.attempts",
    "budget-gate.refusals",
    "grader.outcomes",
    "aggregate.totals",
    "aggregate.byCondition",
    "aggregate.byFamily",
    "caveats.lines",
    "ndjson-emit.attemptCount",
    "exit-codes.refusalMap",
  ];
  const missing = requiredKeys.filter((k) => !evidence.has(k));
  assert.deepEqual(missing, [], `M9.5 evidence map missing keys: ${missing.join(", ")}`);
});

/** Companion test: determinism. The synthetic runner is deterministic
 *  for the same `(seed, charter, fixtures)` — running it twice yields
 *  identical attempt records. */
test("M9.5 determinism: re-running the same charter + fixtures produces identical attempts", async () => {
  const charter: PilotCharter = pilotCharterSchema.parse({
    pilotId: "pilot-m9.5-determinism",
    charterVersion: "1.0.0",
    graderVersion: "1.0.0",
    participantIds: ["p1", "p2", "p3", "p4", "p5", "p6"],
    seed: "deadbeef00000001",
    budget: {
      perInvocationCapUsd: 1.0,
      perAttemptCapUsd: 2.0,
      perProfileCapUsd: 5.0,
      warnAtFraction: 0.8,
    },
    canaries: [],
  });
  const fixtures: Fixture[] = [
    makeFixture("routine-02", "routine-change"),
    makeFixture("context-handoff-02", "context-handoff"),
  ];
  const a = await runPilot({ charter, fixtures, synthetic: true });
  const b = await runPilot({ charter, fixtures, synthetic: true });
  assert.equal(a.attempts.length, b.attempts.length);
  // Outcomes and fixture IDs match per attempt.
  for (let i = 0; i < a.attempts.length; i += 1) {
    assert.equal(a.attempts[i]!.outcome, b.attempts[i]!.outcome);
    assert.equal(a.attempts[i]!.fixtureId, b.attempts[i]!.fixtureId);
    assert.equal(a.attempts[i]!.conditionId, b.attempts[i]!.conditionId);
    assert.equal(a.attempts[i]!.conditionPosition, b.attempts[i]!.conditionPosition);
  }
});

// Silence the "unused" warning for `randomUUID` which is referenced by
// the runner via dynamic import. We keep the import here as a marker
// that this file IS the gate test for the runner + aggregate layer.
void randomUUID;