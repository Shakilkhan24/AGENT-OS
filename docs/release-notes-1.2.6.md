# MINIMAL 1.2.6 — pilot harness + refuse-to-spend path

This release closes the M9.5 bullet from
[`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md).
It is an opt-in pilot harness; the supported prefix of user-facing
features is unchanged from 1.2.5. Nothing in the supported prefix
invokes the pilot automatically.

## Pilot harness (opt-in)

The M9.5 deliverable is a counterbalanced pilot runner for comparing
the three workflows (terminal-baseline, native-provider, minimal)
on matched `(providerVersion, model, account/quota, tools)` triples.
The harness ships:

- **Pre-registration charter.** [`docs/pilot-charter.md`](pilot-charter.md)
  locks the M9.5 study design at `charterVersion: "1.0.0"`: N=6,
  Williams 3×6 in one balanced block, three USD caps
  (`perInvocationCapUsd`, `perAttemptCapUsd`, `perProfileCapUsd`),
  warn-at-0.8, unknown-cost discipline.
- **20-fixture skeleton bank.** 4 fixtures per family across the
  5 families from `FUTURE/docs/research/10-evaluation-productivity.md §3`
  (`routine-change`, `context-handoff`, `parallel-integration`,
  `interruption-recovery`, `recipe-review`) under
  `tests/fixtures/pilot/`. Schema-valid; concrete acceptance-rule
  bodies are follow-up work.
- **Williams 3×6 counterbalance.** [`src/runtime/pilot/counterbalance.ts`](../src/runtime/pilot/counterbalance.ts)
  exposes `conditionOrderFor(participantId, seed)` and
  `fixtureShuffleFor(...)` as deterministic sha256-keyed helpers.
- **Refuse-to-spend gate.** [`src/runtime/pilot/budget-gate.ts`](../src/runtime/pilot/budget-gate.ts)
  classifies each observation's reported spend as `ok | warn | refuse`
  and emits `BudgetEvent` records on `warn` / `refuse`. Refusal halts
  the current attempt and surfaces `outcome: "abandoned"` with
  `failure.code = "BUDGET_EXCEEDED"` (extended in `src/shared/errors.ts`).
- **Grader.** [`src/runtime/pilot/grader.ts`](../src/runtime/pilot/grader.ts)
  evaluates each fixture's `acceptance[]` rules against captured
  artifacts and rolls them into an `AttemptOutcome`. Soft rules
  (`mustPass: false`) record the failure on the decision surface
  but do not reject the attempt.
- **Runner + aggregate reporter.**
  [`src/runtime/pilot/runner.ts`](../src/runtime/pilot/runner.ts) and
  [`src/runtime/pilot/aggregate.ts`](../src/runtime/pilot/aggregate.ts)
  drive a pilot end-to-end and assemble a `PilotReport` whose
  `caveats[]` field carries the four honest-limit lines by default —
  including the literal "this pilot cannot establish universal
  productivity multipliers" disclaimer. First-class report field,
  not buried in prose.
- **CLI.** [`scripts/run-pilot.mts`](../scripts/run-pilot.mts) mirrors
  the `diagnostics-export` exit-code contract (0/1/2/3). Invoke
  via `npm run pilot:run` (real) or `npm run pilot:synthetic` (no I/O).

## Honest limits (first-class report field)

The `caveats[]` field on every `PilotReport` carries four lines by
default. These are surfaced as a literal report field, not buried in
prose:

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

## Telemetry-off-by-default preserved

The M9.5 harness respects the M9.4 telemetry-off-by-default contract.
Nothing in the supported prefix invokes the pilot; the only entry
points are `npm run pilot:run` (powered, opt-in) and
`npm run pilot:synthetic` (no I/O, opt-in). The harness does NOT set
`MINIMAL_TELEMETRY=1` or any equivalent env var. The CSP audit
(`tests/desktop/telemetry-csp.spec.ts`) still passes.

## Sample synthetic report

[`tests/fixtures/pilot-synthetic-report.json`](../tests/fixtures/pilot-synthetic-report.json)
is a checked-in `PilotReport` produced by `npm run pilot:synthetic`
against the 20-fixture skeleton bank. The runner can re-produce it
deterministically with `--seed 9aa31be9`. 6 × 20 × 3 = 360 attempts;
totals + byCondition + byFamily + caveats are all populated.

## Supported prefix (advertised workflows)

The supported prefix is unchanged from 1.2.5. The pilot harness is
NOT a supported workflow — it is an opt-in research instrument for
the M9.5 evaluation phase.

## Known follow-ups

- **Concrete fixture bodies.** Acceptance-rule bodies for specific
  fixtures (sha256 references, check name lists, scope paths) are
  follow-up issues. The bank shape is asserted; the bodies are
  placeholders.
- **N=8 extension.** A future milestone can scale to N=8 (Williams
  3×8 or 4×8) once the M9.5 cohort yields no surprises.
- **14-day post-delivery defect window.** A separate study. The M9.5
  pilot records `defectsWithin14d: 0` for every attempt.

## Verification

```bash
# Unit + integration tests for the pilot harness
npx tsx --test src/runtime/pilot/__tests__/counterbalance.test.ts \
                 src/runtime/pilot/__tests__/budget-gate.test.ts \
                 src/runtime/pilot/__tests__/grader.test.ts \
                 tests/runtime/m9_5-pilot-gate.test.ts \
                 tests/runtime/pilot-fixtures.test.ts
# All green.

# Synthetic smoke run
npm run pilot:synthetic
# Exits 0; writes pilot-out/pilot-synthetic-sample/{attempts.ndjson,pilot-report.json}.

# Canary discipline
npm run diagnostics:export pilot-out/pilot-synthetic-sample/ \
  --out pilot-out/pilot-synthetic-sample-bundle \
  --canary synthetic=PILOT-CANARY-9aa31be9
# Exits 1 if a planted canary token survives the scrubber.

# Prior gates still pass
npx tsx --test tests/runtime/m9-gate.test.ts \
                 tests/runtime/m6-gate.test.ts \
                 tests/runtime/m7-gate.test.ts
# All green.

# Typecheck + build
npx tsc --noEmit
npm run build
```