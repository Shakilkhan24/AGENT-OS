# Runbook — run a pilot

How to operate the M9.5 pilot harness from the operator's seat.
The harness is opt-in: nothing in the supported prefix invokes it
automatically. The only ways to run a pilot are `npm run pilot:run`
or `npm run pilot:synthetic`.

## Quickstart (synthetic)

The synthetic mode runs the runner end-to-end without any real I/O.
Use it to verify the harness is wired correctly before a powered run.

```bash
npm run pilot:synthetic
# → exits 0; writes pilot-out/<pilotId>/{attempts.ndjson,pilot-report.json}
```

The synthetic mode produces 6 participants × 5 fixtures × 3
conditions = 90 attempts. Every attempt cycles through one of
`accepted | rejected | timeout` deterministically (the cycle is
keyed on `(participantId, fixtureId, conditionId)`).

## Quickstart (real)

A powered run requires a charter JSON. The minimal charter:

```json
{
  "pilotId": "pilot-2026-09",
  "charterVersion": "1.0.0",
  "graderVersion": "1.0.0",
  "participantIds": ["alice", "bob", "carol", "dave", "eve", "frank"],
  "seed": "9aa31be9cafe0001",
  "budget": {
    "perInvocationCapUsd": 0.10,
    "perAttemptCapUsd": 0.20,
    "perProfileCapUsd": 5.00,
    "warnAtFraction": 0.8
  },
  "canaries": []
}
```

```bash
npm run pilot:run path/to/charter.json \
  --fixtures-dir tests/fixtures/pilot \
  --out pilot-out \
  --canary session=PILOT-CANARY-9aa31be9
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | clean: at least one attempt was produced and no refusal occurred. |
| `1` | at least one attempt was abandoned due to budget refusal. Inspect `pilot-report.json#budgetEvents`. |
| `2` | no fixtures discovered (synthetic or real). Check `--fixtures-dir`. |
| `3` | charter schema violation. The error message identifies the failing field. |

## Output surface

The harness writes:

```
<out-dir>/<pilotId>/
  ├── attempts.ndjson     # append-only, one record per attempt
  └── pilot-report.json   # aggregate, re-written on every run
```

`attempts.ndjson` is the canonical audit surface. The
`pilot-report.json` is a derived view — it is re-written on every
run; consumers should not depend on it being stable across runs.

## Canary discipline

After a run, route the NDJSON through the diagnostics-export
pipeline and verify the canary tokens were scrubbed:

```bash
npm run diagnostics:export pilot-out/<pilotId>/ \
  --out pilot-out/<pilotId>-bundle \
  --canary session=PILOT-CANARY-9aa31be9
# → exit 1: canary escaped. The pipeline refuses to publish
#   a bundle that still carries the canary literal.
```

A run that exits 0 from the canary audit is "canary-clean" — the
scrubber removed every token the reviewer declared.

## Telemetry-off-by-default

The pilot harness respects the M9.4 telemetry-off-by-default
contract (`src/shared/settings.ts` → `settings.telemetry: false`).
It does NOT enable telemetry, set `MINIMAL_TELEMETRY=1`, or read
any data the user has not opted into. The only data the harness
writes is the NDJSON / report under the operator-specified `--out`
directory.

## When the gate refuses

If the budget gate refuses (exit 1), inspect
`pilot-report.json#budgetEvents` for the `refuse` records. Each
record carries:

- `cap` — which cap was breached (`perInvocationCapUsd`,
  `perAttemptCapUsd`, `perProfileCapUsd`).
- `observedUsd` / `capUsd` — the running tally at decision time.
- `participantId` / `attemptId` — which (participant, attempt) hit
  the cap.
- `reason` — human-readable explanation.

The runner halts the current attempt but does NOT halt the pilot —
remaining attempts continue. The aggregate `totals.budgetRefusals`
counter is incremented; the `pilotReport.caveats[]` field still
carries the four honest-limit lines.

## See also

- [`docs/pilot-charter.md`](../pilot-charter.md) — the full pre-registration charter.
- [`scripts/diagnostics-export.mts`](../../scripts/diagnostics-export.mts) — the canary audit pipeline.
- [`docs/diagnostics.md`](../diagnostics.md) — telemetry defaults and scrubber roles.
- [`docs/compatibility.md`](../compatibility.md) — provider version pinning for matched triples.