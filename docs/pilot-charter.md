# M9.5 Pilot Charter

> **Pre-registration statement.** This document is the pilot charter
> locked at version `1.0.0` for the M9.5 cut (MINIMAL 1.2.6). The
> wording of the M9.5 bullet (`FUTURE/IMPLEMENTATION-README.md`
> line 289) is preserved verbatim below; this pilot does NOT power a
> sample. It is a starting proposal: the fixture bank is a skeleton
> (concrete acceptance-rule bodies are follow-up work); the cohort
> is N=6; the budget caps are the floor, not the ceiling.
>
> > *Compare useful tasks against the user's current terminal
> > workflow and native provider workflow with matched
> > versions/budgets. Measure accepted outcomes, review/recovery
> > effort, defects, all attempts and unknown cost. Counterbalance
> > task order; small pilots cannot establish universal productivity
> > multipliers.*

## 1. Hypotheses (informational)

The pilot is not a powered sample. We frame three informational
hypotheses that the aggregate report can speak to, but NO claim of
universal productivity multipliers is made:

- **H1.** Across the five fixture families, the `minimal` condition
  does not regress on accepted-outcome rate against `native-provider`
  for matched provider versions.
- **H2.** Review/recovery effort (captured as `humanMinutes`) on the
  `minimal` condition is no greater than on `native-provider` for
  the same fixture, within the pilot's measurement scope.
- **H3.** Defect rate (captured as `rejected + abandoned` outcomes)
  on `minimal` is no greater than on `native-provider`.

## 2. Refusal contract

The pilot will REFUSE to spend when any of three USD caps is
breached. The refusal is a first-class runner state — not a soft
warning:

| Cap | Meaning |
|---|---|
| `perInvocationCapUsd` | A single invocation cannot exceed this USD. |
| `perAttemptCapUsd` | Cumulative spend within one attempt cannot exceed this USD. |
| `perProfileCapUsd` | Cumulative spend across a participant's full pilot cannot exceed this USD. |

The default for the M9.5 cut:

```json
{
  "perInvocationCapUsd": 0.10,
  "perAttemptCapUsd": 0.20,
  "perProfileCapUsd": 5.00,
  "warnAtFraction": 0.80
}
```

When usage crosses `warnAtFraction` of any cap, the runner emits a
`BudgetEvent` with `kind: "warn"` and continues. When usage crosses
the cap itself, the runner emits a `BudgetEvent` with `kind: "refuse"`
and halts the current attempt (`outcome: "abandoned"`).

**Unknown-cost discipline:** when the provider does not report
`costUsd`, the attempt is recorded with `unknownCost: true` and
contributes zero to the running tally. Estimates are NEVER
substituted.

## 3. Conditions (matched triples)

Each fixture ships three drivers — one per condition. A driver
binds a `(providerVersion, model, account/quota, tools)` tuple to
the fixture's task surface. The matched-triple invariant is
enforced by the `fixtureSchema` refine: drivers MUST cover all three
conditions exactly once.

| Condition | Tools | Provider |
|---|---|---|
| `terminal-baseline` | tmux + native CLI | n/a |
| `native-provider` | native (claude or codex) | pinned via `providerPin` |
| `minimal` | MINIMAL dispatch + workflow executor | pinned via `providerPin` |

## 4. Cohort

- **N = 6 participants.**
- **Williams 3×6 in one balanced block.** Every adjacent (unordered)
  pair of conditions appears exactly 4 times across the 6 rows.
- Condition order is derived deterministically per `(seed,
  participantId)` via sha256 mod 6 — see
  `src/runtime/pilot/counterbalance.ts`.
- Fixture order within a participant is independent (Fisher-Yates
  over the fixture ids, keyed on the same `(seed, participantId)`).

## 5. Fixture bank

- `tests/fixtures/pilot/` — 20 JSON files: 4 per family across 5
  families (`routine-change`, `context-handoff`,
  `parallel-integration`, `interruption-recovery`, `recipe-review`).
- M9.5 ships schema-valid stubs with minimal bodies. Concrete
  acceptance-rule bodies (e.g. specific sha256 references for
  `routine-01`) are follow-up work.
- The bank shape is asserted by `tests/runtime/pilot-fixtures.test.ts`.

## 6. Metrics

| Metric | Operational definition | Capture path | Known biases |
|---|---|---|---|
| Accepted outcome | `outcome === "accepted"` per attempt | `pilotReport.totals.accepted` + `byCondition` + `byFamily` | Synthetic mode cycles deterministically; not a powered sample. |
| Review/recovery effort | `humanMinutes` per attempt | `attemptRecord.humanMinutes` | Self-reported only. Within-attempt variance not captured (one trial per cell). |
| Defects | `outcome ∈ {rejected, abandoned}` | `pilotReport.totals.{rejected, abandoned}` | 14-day post-delivery defect window is NOT part of this pilot — see §8. |
| All attempts | One record per `(participant, fixture, condition)` cell | `pilotReport.perAttempt[]` (90 records for N=6 × 5 fixtures × 3 conditions) | No mid-trial rescoring. |
| Unknown cost | `attemptRecord.unknownCost === true` | `pilotReport.totals.unknownCostAttempts` + `caveats[]` line 3 | Providers that report costs are over-represented in `totalCostUsd`. |

## 7. Honest-limit disclosure (verbatim)

The aggregate report's `caveats[]` field carries four lines by
default. These are NOT documentation — they are a literal report
field, surfaced to every consumer of `pilotReportSchema`:

1. Small cohort (N=6, Williams 3×6 in one balanced block): this
   pilot cannot establish universal productivity multipliers.
2. Counterbalance scope: condition order and adjacent-pair balance
   are balanced within the 3×6 square; carry-over across fixtures
   is NOT balanced.
3. Unknown-cost discipline: when `costUsd === null`, attempts are
   reported as `unknownCost` and contribute zero to `totalCostUsd`;
   estimates are never substituted.
4. 3-trial measurement scope: per `(participant, fixture, condition)`
   we record one attempt; the pilot does not estimate within-attempt
   variance.

## 8. Out of scope (explicit follow-ups)

- **N=8 extension.** A future milestone can scale to N=8 (Williams
  3×8 or 4×8) once the M9.5 cohort yields no surprises.
- **14-day post-delivery defect window.** A separate study. The
  M9.5 pilot records `defectsWithin14d: 0` for every attempt.
- **Concrete fixture bodies.** Acceptance-rule bodies for specific
  fixtures (sha256 references, check name lists) are follow-up
  issues. The bank shape is asserted; the bodies are placeholders.

## 9. Append-only ledger policy

The harness emits one `attempts.ndjson` per pilot run, written to
`<outDir>/<pilotId>/attempts.ndjson`. The file is append-only:
re-running with the same `pilotId` writes a new file (timestamped)
and does NOT mutate existing records. `pilot-report.json` is
re-written from scratch each run; consumers MUST treat the NDJSON
as the canonical audit surface and the report as a derived view.

## 10. Implementation cross-references

| Layer | File |
|---|---|
| Schema | [`src/shared/pilot-schema.ts`](../src/shared/pilot-schema.ts) |
| Counterbalance | [`src/runtime/pilot/counterbalance.ts`](../src/runtime/pilot/counterbalance.ts) |
| Budget gate | [`src/runtime/pilot/budget-gate.ts`](../src/runtime/pilot/budget-gate.ts) |
| Grader | [`src/runtime/pilot/grader.ts`](../src/runtime/pilot/grader.ts) |
| Runner | [`src/runtime/pilot/runner.ts`](../src/runtime/pilot/runner.ts) |
| Aggregate | [`src/runtime/pilot/aggregate.ts`](../src/runtime/pilot/aggregate.ts) |
| CLI | [`scripts/run-pilot.mts`](../scripts/run-pilot.mts) |
| Gate test | [`tests/runtime/m9_5-pilot-gate.test.ts`](../tests/runtime/m9_5-pilot-gate.test.ts) |
| Fixture bank test | [`tests/runtime/pilot-fixtures.test.ts`](../tests/runtime/pilot-fixtures.test.ts) |
| Runbook | [`docs/runbooks/run-pilot.md`](runbooks/run-pilot.md) |
| Release notes | [`docs/release-notes-1.2.6.md`](release-notes-1.2.6.md) |

## 11. Charter version policy

Charter versions follow `MAJOR.MINOR.PATCH`. A MAJOR bump is a
breaking change to the matched-triple contract, fixture schema, or
budget gate contract. A MINOR bump adds an informational hypothesis
or a fixture family. A PATCH bump is a documentation-only change.