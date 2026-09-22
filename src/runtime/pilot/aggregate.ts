/**
 * M9.5 — aggregate reporter.
 *
 * `rollAttempts` takes the raw list of `AttemptRecord`s produced by
 * the runner and assembles a `PilotReport`:
 *
 *   - `totals`     — global counters.
 *   - `byCondition` — per-condition rollups (one row per condition).
 *   - `byFamily`    — per-family rollups (one row per family present).
 *   - `budgetEvents` — surfaced from `AttemptRecord.failure` rows that
 *                      carry a `BUDGET_EXCEEDED` code AND from explicit
 *                      budget events the runner records (the runner
 *                      assembles them and passes them via the second
 *                      argument to `rollAttempts`).
 *   - `caveats[]`   — defaulted to `DEFAULT_PILOT_CAVEATS` from the
 *                      schema module. This is the literal home of
 *                      "small pilots cannot establish universal
 *                      productivity multipliers" — first-class
 *                      report field, not buried in prose.
 */
import {
  DEFAULT_PILOT_CAVEATS,
  attemptOutcomeSchema,
  pilotReportByConditionSchema,
  pilotReportByFamilySchema,
  pilotReportTotalsSchema,
  pilotReportSchema,
  type AttemptRecord,
  type BudgetEvent,
  type FixtureFamily,
  type PilotCondition,
  type PilotReport,
  type PilotReportByCondition,
  type PilotReportByFamily,
  type PilotReportCohort,
  type PilotReportTotals,
} from "../../shared/pilot-schema";
import { PILOT_CONDITIONS } from "./counterbalance";

/** Compute the per-condition row, including mean human minutes. */
function byConditionFor(
  condition: PilotCondition,
  attempts: ReadonlyArray<AttemptRecord>,
): PilotReportByCondition {
  const rows = attempts.filter((a) => a.conditionId === condition);
  const totalCostUsd = rows.reduce((acc, a) => acc + (a.costUsd ?? 0), 0);
  const meanHumanMinutes =
    rows.length === 0
      ? 0
      : rows.reduce((acc, a) => acc + a.humanMinutes, 0) / rows.length;
  return pilotReportByConditionSchema.parse({
    condition,
    attempts: rows.length,
    accepted: rows.filter((a) => a.outcome === "accepted").length,
    totalCostUsd,
    meanHumanMinutes,
  });
}

/** Compute the per-family row. */
function byFamilyFor(family: FixtureFamily, attempts: ReadonlyArray<AttemptRecord>): PilotReportByFamily {
  const rows = attempts;
  return pilotReportByFamilySchema.parse({
    family,
    attempts: rows.length,
    accepted: rows.filter((a) => a.outcome === "accepted").length,
  });
}

/**
 * Aggregate a list of attempt records into a `PilotReport`.
 *
 * `budgetEvents` is provided separately because the runner emits them
 * at warn/refuse boundaries — the AttemptRecord itself only carries a
 * `failure.code = "BUDGET_EXCEEDED"` pointer; the full BudgetEvent
 * object is surfaced here.
 */
export function rollAttempts(args: {
  pilotId: string;
  charterVersion: string;
  graderVersion: string;
  startedAt: string;
  finishedAt: string;
  cohort: PilotReportCohort;
  attempts: ReadonlyArray<AttemptRecord>;
  budgetEvents: ReadonlyArray<BudgetEvent>;
  /** Optional override for `caveats[]` (e.g. when adding custom lines). */
  caveats?: ReadonlyArray<string>;
}): PilotReport {
  const attempts = args.attempts;
  const totals: PilotReportTotals = pilotReportTotalsSchema.parse({
    attempts: attempts.length,
    accepted: attempts.filter((a) => a.outcome === "accepted").length,
    rejected: attempts.filter((a) => a.outcome === "rejected").length,
    abandoned: attempts.filter((a) => a.outcome === "abandoned").length,
    timeout: attempts.filter((a) => a.outcome === "timeout").length,
    unknown: attempts.filter((a) => a.outcome === "unknown").length,
    totalCostUsd: attempts.reduce((acc, a) => acc + (a.costUsd ?? 0), 0),
    unknownCostAttempts: attempts.filter((a) => a.unknownCost).length,
    budgetRefusals: args.budgetEvents.filter((b) => b.kind === "refuse").length,
  });

  const byCondition = PILOT_CONDITIONS.map((cond) => byConditionFor(cond, attempts));

  // Group attempts by family — the AttemptRecord shape doesn't carry the
  // family directly, so the runner pre-loads a `participantId → fixtureId → family`
  // map and threads it through. To keep the aggregate pure, we expect the
  // runner to have populated a per-attempt `family` via metadata. Here we
  // treat AttemptRecord as already-family-keyed via a side channel encoded
  // in `attemptId` (`<pilotId>:<participantId>:<fixtureId>:<conditionId>`).
  // For simplicity in M9.5 we collect families by fixtureId prefix, since
  // fixture IDs are namespaced `family-NN` per the fixture contract.
  const familyOf = (id: string): FixtureFamily => {
    if (id.startsWith("routine-")) return "routine-change";
    if (id.startsWith("context-handoff-")) return "context-handoff";
    if (id.startsWith("parallel-integration-")) return "parallel-integration";
    if (id.startsWith("interruption-recovery-")) return "interruption-recovery";
    if (id.startsWith("recipe-review-")) return "recipe-review";
    return "routine-change"; // Defensive default — fixtures MUST use one of the 5 families.
  };
  const byFamilyMap = new Map<FixtureFamily, AttemptRecord[]>();
  for (const a of attempts) {
    const family = familyOf(a.fixtureId);
    const arr = byFamilyMap.get(family) ?? [];
    arr.push(a);
    byFamilyMap.set(family, arr);
  }
  const byFamily: PilotReportByFamily[] = [];
  for (const [family, rows] of [...byFamilyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    byFamily.push(byFamilyFor(family, rows));
  }

  return {
    pilotId: args.pilotId,
    charterVersion: args.charterVersion,
    graderVersion: args.graderVersion,
    generatedAt: new Date().toISOString(),
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    cohort: args.cohort,
    totals,
    byCondition,
    byFamily,
    perAttempt: [...attempts],
    budgetEvents: [...args.budgetEvents],
    caveats: [...(args.caveats ?? DEFAULT_PILOT_CAVEATS)],
  };
}

/** Re-export the schema so the runner can validate before returning. */
export { pilotReportSchema, attemptOutcomeSchema };