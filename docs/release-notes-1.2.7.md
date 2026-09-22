# MINIMAL 1.2.7 — boundary-pinning docs for commercialization validation

This release closes the M9.6 bullet from
[`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md).
It is a docs-only release; **no code in the supported prefix
changes**. The supported prefix of user-facing features is unchanged
from 1.2.6. Nothing in the supported prefix changes its behaviour.

## Why no code change

The M9.6 bullet reads:

> If commercialization is selected, validate the actual
> distribution/authentication rights, support cost, retention and
> paid continuation. Use the
> [commercial experiments](../FUTURE/docs/research/12-commercial-positioning.md)
> as revisable hypotheses. The first offer is personal/host-local;
> owned-host automation and small-team adoption are separate
> cohorts. Keep provider usage financially separate and existing
> work/export accessible after cancellation.

The "if" branch evaluates to false at the time of recording. The
M9.6 cut therefore pins the current boundaries rather than adding
new commercial surfaces. Five boundary docs (this release's entire
surface) record the current posture across the four clauses
(distribution/auth-rights, support-cost, retention, paid
continuation), plus the explicit no-commercialization decision.

## Boundary docs

Five new docs pin the current state. Each carries a freshness-rule
regression test under `tests/docs/` or `tests/release/`.

- **[`docs/distribution.md`](distribution.md)** — the shipped-tree
  inventory, license matrix, update-mechanism statement (Linux-only
  per `scripts/package.mjs:8-9`, unsigned release per
  `scripts/verify-release.mts:11-13`), and counsel-gate reminder
  (research doc 12 lines 70-78, quoted verbatim).
  Refresh guard: `tests/release/distribution-inventory.test.ts`
  asserts the doc carries the six required §-headings, that the
  unsigned disclaimer still lives in `scripts/verify-release.mts`,
  and that the non-linux guard still lives in `scripts/package.mjs`.
- **[`docs/security.md`](security.md)** — the auth-rights
  statement. The principal model is local-only (every `principal`
  string in `src/runtime/db/grants.ts`, `hook-activation.ts`,
  and `lead-admission.ts` is a local IPC string). The anti-self-
  approval rule cascades through three call sites. The failure-code
  table enumerates the authorization-bearing codes (FORBIDDEN,
  LEASE_HELD, LEASE_UNCERTAIN, CONFLICT, NOT_FOUND, BUSY,
  BUDGET_EXCEEDED). The "what MINIMAL does NOT do" section makes
  the absence of remote users, multi-tenant boundaries,
  license-key validation, and remote-revocation paths explicit.
  Refresh guard: `tests/docs/security-statement.test.ts` asserts
  the doc carries the six required §-headings and that
  `src/shared/errors.ts:failureSchema.code` still enumerates
  FORBIDDEN + LEASE_HELD + LEASE_UNCERTAIN.
- **[`docs/provider-economics.md`](provider-economics.md)** — the
  separation commitment. MINIMAL never holds, charges, or
  transfers provider spend (mirrors research doc 12 line 51). The
  three audit surfaces (pricing-catalog, observation,
  budget-gate) are display / audit / enforcement only — never
  billing. The M9.5 refuse-to-spend gate trips
  `AppError("BUDGET_EXCEEDED")`; it does not move money. The
  unknown-cost discipline (`costUsd === null` contributes zero to
  the tally) is recorded as a literal rule.
  Refresh guard: `tests/docs/provider-economics.test.ts` asserts
  the doc carries the five required §-headings, that
  `budget-gate.ts` still emits `AppError("BUDGET_EXCEEDED")`, and
  that the `costUsd === null` discipline string is still present.
- **[`docs/commercial-decision.md`](commercial-decision.md)** — the
  explicit no-commercialization record. Pinned at charter version
  `1.0.0`. §3 lists the reversal criteria (cohort go/no-go rule
  met for at least one of the three research-doc experiments +
  counsel review of the four research-doc gates + a separate
  milestone that delivers the corresponding primitives). §4 records
  the explicit absence of a support-cost model in code. §5 quotes
  research doc 12 line 82 verbatim.
  Refresh guard: `tests/docs/commercial-decision.test.ts` asserts
  the doc carries the six required §-headings and references all
  four boundary docs by relative path.
- **[`docs/runbooks/cancel-and-walk-away.md`](runbooks/cancel-and-walk-away.md)**
  — the operator's portability drill. Walks the four phases
  (backup, verify, diagnostics, restore) end-to-end on a clean
  supported machine. §6 ("what does NOT transfer") restates
  research doc 12 line 82 verbatim and lists provider accounts,
  provider-owned hidden state, credentials, anything outside the
  22-key allowlist, and provider binaries / SDKs as
  non-transferable. The runbook is **not** a portability
  promise — it's a portability **demo** with its limits stated
  up front.
  Refresh guard: `tests/release/cancel-walkaway.test.ts` asserts
  the runbook walks the four phases in order, that
  `src/runtime/db/backup.ts` still exports the five portability
  primitives, that `scripts/diagnostics-export.mts` still exists,
  and that `docs/recovery.md` still exists.

## What MINIMAL 1.2.7 does NOT add

The M9.6 cut is deliberately additive in docs only. **No new code
paths are introduced.** The decision record + the four boundary
docs + the regression tests that guard them are the entirety of
the M9.6 surface.

Specifically, the M9.6 cut does **not** add:

- **Billing.** No payment processing, no subscription model, no
  invoice / receipt / charge primitives.
- **License-key validation.** No activation-token model, no
  entitlement check at startup, no license-key store.
- **Multi-tenant principal model.** The principal string remains
  a local IPC principal; see `docs/security.md` §1.
- **Cryptographic signing** of the release artifact. The release
  remains unsigned per `scripts/verify-release.mts:11-13`.
- **Package-manager packaging** (deb / rpm / AppImage). The
  release tree is the supported artifact.
- **Auto-update wiring** (electron-updater / Squirrel / Sparkle).
  No update channel is wired.
- **Hosted-execution surface.** MINIMAL 1.2.7 is local-only.

If commercialization is ever selected, every one of those surfaces
would be a separate milestone with its own gate test and its own
release-notes entry. See `docs/commercial-decision.md` §3 for the
reversal criteria.

## Honest limits of the boundary docs

The boundary docs are pinned at this cut. They are reversible, but
reversal is not a casual undo:

1. **Research-doc §12 is a proposal.** Line 3 of research doc 12
   says "this is a proposal: no interviews, pilots, purchases,
   revenue measurements, or license clearance were conducted." No
   claims about customer demand, revenue, or paid continuation
   are made by the M9.6 cut or by `docs/commercial-decision.md`.
2. **Counsel review is required.** The four research-doc gates
   at lines 70-78 (artifact inventory, provider confirmation,
   branding check, distribution / hosting model determination)
   are not answered by M9.6. They point at counsel, not at this
   codebase.
3. **The reversal criteria are strict.** Reversal requires (a) at
   least one of the three experiment packages' go/no-go rule
   met, (b) counsel review of all four gates, (c) a separate
   milestone that delivers the corresponding primitive. All three.
4. **The boundary docs do not enumerate every gap.** The
   signing gap is called out in `docs/distribution.md` §6 but
   not closed. The provider-owned hidden state is documented as
   non-transferable in §6 of the cancel-and-walk-away runbook
   but no path to make it transferable exists in 1.2.7.

## Telemetry-off-by-default preserved

The M9.6 boundary docs do not change the telemetry-off-by-default
contract. `settings.telemetry: false` default is unchanged; the
22-key allowlist scrubber is unchanged; the canary pipeline still
catches planted tokens; the CSP audit
(`tests/desktop/telemetry-csp.spec.ts`) still passes.

## Supported prefix (advertised workflows)

The supported prefix is unchanged from 1.2.6. The M9.6 boundary
docs are NOT a supported workflow — they are a portability
contract for the operator and a reversal criterion checklist for
future milestones. The pilot harness from M9.5 is unchanged and
remains opt-in.

## Known follow-ups

- **Signing gap.** The release artifact is unsigned
  (`scripts/verify-release.mts:11-13`). Closing the gap is large
  future work scoped out of M9.6; see
  [`docs/distribution.md`](distribution.md) §6.
- **Package-manager packaging.** deb / rpm / AppImage packaging
  is out of scope for M9.6 (see `docs/distribution.md` §6).
- **Auto-update wiring.** Out of scope for M9.6; see
  `docs/distribution.md` §6.
- **Cohort evidence for reversal.** The three experiment
  packages in research doc 12 lines 33-35 have not been run.
  Reversal requires at least one to hit its go/no-go rule. See
  [`docs/commercial-decision.md`](commercial-decision.md) §3.
- **Counsel review for reversal.** The four research-doc gates
  at lines 70-78 are unanswered; reversal requires counsel to
  answer all four. See
  [`docs/commercial-decision.md`](commercial-decision.md) §3.

## Verification

```bash
# Doc tests — the freshness-rule guards
npx tsx --test tests/release/distribution-inventory.test.ts \
                 tests/docs/security-statement.test.ts \
                 tests/docs/provider-economics.test.ts \
                 tests/docs/commercial-decision.test.ts \
                 tests/release/cancel-walkaway.test.ts                       # all green

# Doc presence — the boundary docs must cite the right code paths
grep -q "scripts/verify-release.mts" docs/distribution.md                      # unsigned statement
grep -q "src/shared/errors.ts" docs/security.md                               # failure-code citation
grep -q "src/runtime/pilot/budget-gate.ts" docs/provider-economics.md         # gate citation
grep -q "src/runtime/db/backup.ts" docs/runbooks/cancel-and-walk-away.md      # backup citation

# Prior gates (M9.5 + earlier) still pass
npx tsx --test tests/runtime/m9_5-pilot-gate.test.ts \
                 tests/runtime/m9-gate.test.ts \
                 tests/runtime/m6-gate.test.ts \
                 tests/runtime/m7-gate.test.ts                                # all green

# CSP audit still locked
npx playwright test tests/desktop/telemetry-csp.spec.ts --grep "source"       # static file check passes

# Typecheck + build — no new code, but guards against accidental breakage
npx tsc --noEmit                                                              # 0 errors
npm run build
```
