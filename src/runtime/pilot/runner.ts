/**
 * M9.5 — pilot runner.
 *
 * `runPilot` orchestrates a counterbalanced pilot. Per
 * `(participant, fixture, condition)` tuple it:
 *
 *   1. Derives `attemptOrder` (1-based per `(participant, fixture)`)
 *      and `conditionPosition` (0-based in the participant's order)
 *      via `counterbalance.ts`.
 *   2. Runs one attempt through the chosen dispatch seam — either
 *      the real runner via `RunAttemptFn`, or the synthetic
 *      deterministic stub via `syntheticAttempt()` when
 *      `synthetic: true`.
 *   3. Wraps each observation through `budget-gate.classifySpend`,
 *      accumulating into `PilotBudgetState` for the attempt + profile
 *      axes.
 *   4. Captures `CapturedArtifacts` from the dispatch result and asks
 *      the grader to evaluate `fixture.acceptance[]` + summarise the
 *      outcome.
 *   5. Emits one `AttemptRecord` to the in-memory `attempts` list
 *      (the CLI writes them to `<outDir>/<pilotId>/attempts.ndjson`).
 *
 * The runner is also responsible for emitting `BudgetEvent` rows
 * for every `warn` / `refuse` classification. A refusal halts the
 * current attempt and surfaces an `abandoned` outcome with
 * `failure.code = "BUDGET_EXCEEDED"`.
 */
import { randomUUID } from "node:crypto";
import {
  attemptRecordSchema,
  attemptOutcomeSchema,
  type AttemptOutcome,
  type AttemptRecord,
  type BudgetEvent,
  type Fixture,
  type PilotCharter,
  type PilotCondition,
  type PilotReportCohort,
  type AcceptanceDecision,
} from "../../shared/pilot-schema";
import {
  conditionOrderFor,
  conditionPositionsFor,
  fixtureShuffleFor,
} from "./counterbalance";
import {
  classifySpend,
  accumulateSpend,
  buildBudgetEvent,
  type PilotBudgetState,
} from "./budget-gate";
import { gradeAttempt, type CapturedArtifacts } from "./grader";

/** Per-attempt dispatch seam — the runner calls this once per attempt. */
export interface RunAttemptFn {
  (args: {
    fixture: Fixture;
    condition: PilotCondition;
    participantId: string;
    attemptOrder: number;
  }): Promise<RunAttemptResult>;
}

/** Result returned by the dispatch seam. */
export interface RunAttemptResult {
  startedAt: string;
  endedAt: string;
  humanMinutes: number;
  captured: CapturedArtifacts;
  /** Provider fingerprint for the audit trail. */
  providerFingerprint: string;
}

/** Synthetic stub — deterministic, no I/O. */
export function syntheticAttempt(args: {
  fixture: Fixture;
  condition: PilotCondition;
  participantId: string;
  attemptOrder: number;
}): RunAttemptResult {
  const cycle = ["accepted", "rejected", "timeout"] as const;
  // The synthetic outcome is a stable function of (participantId, fixtureId, conditionId)
  // so the same inputs produce the same result. This lets the gate test
  // assert reproducibility without real I/O.
  const key = `${args.participantId}:${args.fixture.id}:${args.condition}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  const outcome = cycle[hash % cycle.length]!;
  const startedAt = new Date(0).toISOString();
  const endedAt = new Date(60_000).toISOString();
  const humanMinutes = 5;
  // The captured bundle reflects the synthetic outcome:
  //   - `accepted` → reviewStatus=accepted, checkResults=[{lint, passed}], cost=0.05
  //   - `rejected` → reviewStatus=rejected, checkResults=[{lint, failed}], cost=0.07
  //   - `timeout`  → reviewStatus=pending, checkResults=[], cost=0.02
  const captured: CapturedArtifacts = {
    checkResults:
      outcome === "accepted"
        ? [{ name: "lint", status: "passed", detail: "ok" }]
        : outcome === "rejected"
          ? [{ name: "lint", status: "failed", detail: "lint error" }]
          : [],
    candidateTreeSha256: outcome === "accepted" ? "a".repeat(64) : null,
    candidateDiffSha256: outcome === "accepted" ? "b".repeat(64) : null,
    reviewStatus:
      outcome === "accepted" ? "accepted"
        : outcome === "rejected" ? "rejected"
          : "pending",
    observedInvocationIds: [randomUUID()],
    costUsd: outcome === "accepted" ? 0.05 : outcome === "rejected" ? 0.07 : 0.02,
    humanMinutes,
  };
  return {
    startedAt,
    endedAt,
    humanMinutes,
    captured,
    providerFingerprint: `synthetic:${args.condition}`,
  };
}

/** Runner input shape. */
export interface RunPilotInput {
  charter: PilotCharter;
  fixtures: ReadonlyArray<Fixture>;
  /** When true, use the synthetic dispatch seam. */
  synthetic?: boolean;
  /** Inject a custom dispatch seam (defaults to `syntheticAttempt`). */
  dispatch?: RunAttemptFn;
}

export interface PilotRunResult {
  attempts: ReadonlyArray<AttemptRecord>;
  budgetEvents: ReadonlyArray<BudgetEvent>;
  cohort: PilotReportCohort;
  startedAt: string;
  finishedAt: string;
}

/**
 * Run a pilot end-to-end. Pure-orchestration; no I/O. The CLI layer
 * (`scripts/run-pilot.mts`) is responsible for filesystem I/O, NDJSON
 * emission, and exit-code translation.
 */
export async function runPilot(input: RunPilotInput): Promise<PilotRunResult> {
  const { charter, fixtures } = input;
  const dispatch: RunAttemptFn =
    input.dispatch ??
    ((syntheticAttempt as unknown) as RunAttemptFn);
  const startedAt = new Date().toISOString();

  const fixturesById = new Map(fixtures.map((f) => [f.id, f]));
  const fixtureIds = fixtures.map((f) => f.id);

  const cohort: PilotReportCohort = {
    participantIds: charter.participantIds,
    conditionOrderByParticipant: {},
  };
  for (const participantId of charter.participantIds) {
    const order = conditionOrderFor(participantId, charter.seed);
    cohort.conditionOrderByParticipant[participantId] = [...order];
  }

  const attempts: AttemptRecord[] = [];
  const budgetEvents: BudgetEvent[] = [];
  const profileStates = new Map<string, PilotBudgetState>();
  for (const pid of charter.participantIds) {
    profileStates.set(pid, { attemptSpentUsd: 0, profileSpentUsd: 0 });
  }

  for (const participantId of charter.participantIds) {
    const order = conditionOrderFor(participantId, charter.seed);
    const positions = conditionPositionsFor(order);
    const shuffledFixtures = fixtureShuffleFor(participantId, charter.seed, fixtureIds);

    for (let attemptOrder = 1; attemptOrder <= shuffledFixtures.length; attemptOrder += 1) {
      const fixtureId = shuffledFixtures[attemptOrder - 1]!;
      const fixture = fixturesById.get(fixtureId)!;

      for (let condIdx = 0; condIdx < order.length; condIdx += 1) {
        const condition = order[condIdx]!;
        const conditionPosition = positions[condition]!;

        const state = profileStates.get(participantId)!;
        // Reset attempt axis for this (participant, fixture, condition) tuple.
        const attemptState: PilotBudgetState = {
          attemptSpentUsd: 0,
          profileSpentUsd: state.profileSpentUsd,
        };

        const attemptId = randomUUID();
        const now = new Date().toISOString();

        let attemptEndedAt = now;
        let attemptStartedAt = now;
        let humanMinutes = 0;
        let captured: CapturedArtifacts = {
          checkResults: [],
          candidateTreeSha256: null,
          candidateDiffSha256: null,
          reviewStatus: null,
          observedInvocationIds: [],
          costUsd: null,
          humanMinutes: null,
        };
        let providerFingerprint = "unknown";
        let outcome: AttemptOutcome = "unknown";
        let decisions: AcceptanceDecision[] = [];
        let failure: AttemptRecord["failure"] = null;

        try {
          const result = input.synthetic || !input.dispatch
            ? syntheticAttempt({ fixture, condition, participantId, attemptOrder })
            : await dispatch({ fixture, condition, participantId, attemptOrder });
          attemptStartedAt = result.startedAt;
          attemptEndedAt = result.endedAt;
          humanMinutes = result.humanMinutes;
          captured = result.captured;
          providerFingerprint = result.providerFingerprint;

          // Budget gate — applied AFTER the dispatch returns its captured
          // artifacts so we never call classifySpend with un-built inputs.
          const observed = { costUsd: captured.costUsd };
          const cls = classifySpend({ observed, state: attemptState, budget: charter.budget });

          // Emit budget event for warn/refuse BEFORE accumulating so the
          // tally on the event matches the running state at decision time.
          if (cls.kind === "warn" || cls.kind === "refuse") {
            budgetEvents.push(buildBudgetEvent({
              classification: cls,
              participantId,
              attemptId,
              at: new Date().toISOString(),
            }));
          }

          if (cls.kind === "refuse") {
            outcome = "abandoned";
            failure = { code: "BUDGET_EXCEEDED", message: cls.reason };
          } else {
            const grade = gradeAttempt(fixture.acceptance, captured);
            outcome = grade.outcome;
            decisions = grade.decisions;
          }

          // Accumulate into the profile axis only when cost is known.
          const nextProfile = accumulateSpend(
            { attemptSpentUsd: 0, profileSpentUsd: state.profileSpentUsd },
            observed,
          );
          profileStates.set(participantId, {
            attemptSpentUsd: 0,
            profileSpentUsd: nextProfile.profileSpentUsd,
          });
        } catch (err) {
          outcome = "abandoned";
          failure = {
            code: (err as { code?: string }).code ?? "INTERNAL",
            message: (err instanceof Error ? err.message : String(err)).slice(0, 4096),
          };
        }

        // Validate the attempt outcome against the schema enum (catches
        // grader regressions where an unknown literal leaks through).
        attemptOutcomeSchema.parse(outcome);

        const record: AttemptRecord = attemptRecordSchema.parse({
          attemptId,
          pilotId: charter.pilotId,
          charterVersion: charter.charterVersion,
          graderVersion: charter.graderVersion,
          participantId,
          conditionId: condition,
          fixtureId,
          attemptOrder,
          conditionPosition,
          outcome,
          humanMinutes,
          startedAt: attemptStartedAt,
          endedAt: attemptEndedAt,
          costUsd: captured.costUsd,
          unknownCost: captured.costUsd === null,
          failure,
          acceptanceDecisions: decisions,
          providerFingerprint,
        });
        attempts.push(record);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    attempts,
    budgetEvents,
    cohort,
    startedAt,
    finishedAt,
  };
}