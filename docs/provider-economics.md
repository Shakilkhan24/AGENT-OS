# Provider economics — separation commitment

> **Status (M9.6):** boundary-pinning doc. Records the commitment
> that MINIMAL never holds, charges, or transfers provider spend.
> The separation exists structurally in code; this doc pins the
> commitment in writing. When the posture changes (e.g. a
> metered-compute offer is added), update this doc and re-run the
> regression test that guards it — see
> `tests/docs/provider-economics.test.ts`.

## 1. Commitment

**MINIMAL never holds, charges, or transfers provider spend.** All
provider subscriptions and API credentials remain user-owned. The
runtime's USD surface is *the user's* USD spent against *user-owned*
provider subscriptions; nothing routes that through MINIMAL.

This commitment mirrors research doc 12 line 51:

> User-owned provider subscriptions/API usage and customer-owned
> host bills are excluded from MINIMAL revenue and costs. They still
> affect the customer's total willingness to pay.

It also mirrors the M9.6 bullet's verbatim clause: *"Keep provider
usage financially separate and existing work/export accessible
after cancellation."*

## 2. Audit surfaces

The runtime has three surfaces that bear on provider spend, all of
which are display / audit / enforcement — not charging:

| Surface | What it does | Source |
| --- | --- | --- |
| `pricing-catalog.ts` | Pins a USD price-per-million-tokens row to `meta` under `pricing:<tierDigest>:<providerVersion>`. `costFromPricing` computes USD from observed tokens. **Display + audit only.** | `src/runtime/db/pricing-catalog.ts:74-76, 206-225` |
| `observation.ts` | Writes `event` rows of type `provider.observation` carrying token counts + `costUsd` + `pricingTierDigest`. **`costUsd: null`** when the provider didn't report usage — never derived from process uptime or the host clock. | `src/runtime/orchestration/observation.ts:41-63` |
| `budget-gate.ts` (M9.5) | Refuse-to-spend gate: classifies each observation's reported spend as `ok \| warn \| refuse` against three USD caps. Refusal emits `BudgetEvent` + halts dispatch via `AppError("BUDGET_EXCEEDED")`. **Enforcement only.** | `src/runtime/pilot/budget-gate.ts` |

None of these surfaces collect, transfer, or aggregate payment. The
runtime never holds a balance; the user pays their provider directly
under their existing subscription terms.

## 3. The budget gate is enforcement, not billing

The M9.5 refuse-to-spend gate (`src/runtime/pilot/budget-gate.ts`)
issues `AppError("BUDGET_EXCEEDED")` on cap breach. The error code
is in `src/shared/errors.ts:failureSchema.code` and the rejection
shape is the standard `AppError` envelope (see
`src/shared/errors.ts:27-45`). The runner halts the current attempt
and emits a `BudgetEvent`; **it does not move money**.

Unknown-cost discipline: when `observed.costUsd === null`, the gate
returns `ok` with `unknownCost: true` and contributes zero to the
tally — estimates are NEVER substituted. See
`src/runtime/pilot/budget-gate.ts:78-84`. The pilot's
`pilotReport.caveats[]` field surfaces this discipline as a literal
report field.

## 4. Portability — what the backup takes, what it doesn't

`src/runtime/db/backup.ts` walks the following tables at backup
time (line 114-119):

> `session, terminal, preset, env_profile, hook, launch, event, draft, meta`

**Not in the manifest surface:**

- Provider profiles (Codex / Claude account state).
- OAuth tokens, API keys, credentials.
- Provider-owned hidden state (conversations, cached inference,
  per-account rate-limit counters).

Research doc 12 line 82 makes this explicit:

> Keep project files, already-created results, essential recovery,
> and export accessible after cancellation. Export readable
> task/recipe manifests, handoffs, artifact references, review
> evidence, and schema versions; exclude credentials. Document what
> cannot transfer, including provider-owned hidden state.
> Demonstrate import on a clean supported machine and continued
> access if MINIMAL's service disappears.

The M9.6 cancel-and-walk-away runbook (`docs/runbooks/cancel-and-walk-away.md`)
restates this boundary verbatim. If the user wants to keep their
provider-side state, they keep it through their provider's own
export path — not through MINIMAL.

## 5. Freshness rule

Every release bump re-validates this doc. The regression test at
`tests/docs/provider-economics.test.ts` asserts:

1. This doc exists and contains the four required §-headings
   (§1-§4 are structural; §5 is the freshness rule).
2. `src/runtime/pilot/budget-gate.ts` still emits
   `AppError("BUDGET_EXCEEDED")` (the refuse-to-spend code).

A future commit that removes the budget gate, the
`costUsd: null` discipline, or the backup's omission of provider
profiles MUST update both this doc and the cited code. The test
failure is the signal.

## See also

- [`docs/commercial-decision.md`](commercial-decision.md) — the explicit no-commercialization record.
- [`docs/distribution.md`](distribution.md) — shipped tree + update-mechanism statement.
- [`docs/security.md`](security.md) — auth-rights statement.
- [`docs/runbooks/cancel-and-walk-away.md`](runbooks/cancel-and-walk-away.md) — the operator's cancellation drill.
- [`src/runtime/db/pricing-catalog.ts`](../src/runtime/db/pricing-catalog.ts) — USD display catalog.
- [`src/runtime/orchestration/observation.ts`](../src/runtime/orchestration/observation.ts) — observation log.
- [`src/runtime/pilot/budget-gate.ts`](../src/runtime/pilot/budget-gate.ts) — refuse-to-spend gate (M9.5).
- [`FUTURE/docs/research/12-commercial-positioning.md`](../FUTURE/docs/research/12-commercial-positioning.md) — research doc 12.