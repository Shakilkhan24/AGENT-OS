# Commercial decision — record (charter version 1.0.0)

> **Status:** This is the explicit decision record for the M9.6
> bullet. The bullet reads *"If commercialization is selected…"*
> — this doc records that **commercialization has NOT been
> selected** as of the M9.6 cut. The record is pinned at version
> `1.0.0` (charter versioning mirrors the pilot charter's
> MAJOR.MINOR.PATCH). A future milestone can flip the decision;
> §3 below lists the reversal criteria.

## 1. Decision

**Decision ID:** `commercial-decision@1.0.0`  
**Recorded:** M9.6 (MINIMAL 1.2.7)  
**Decision:** *Commercialization is not selected at this time.*

The M9.6 bullet at `FUTURE/IMPLEMENTATION-README.md` line 290
conditions the work on *"if commercialization is selected"*. The
"if" branch evaluates to false at the time of recording. The M9.6
cut therefore pins the current boundaries rather than adding new
commercial surfaces — see
[`docs/distribution.md`](distribution.md),
[`docs/security.md`](security.md),
[`docs/provider-economics.md`](provider-economics.md), and the
cancel-and-walk-away runbook at
[`docs/runbooks/cancel-and-walk-away.md`](runbooks/cancel-and-walk-away.md).

The research doc that frames this work —
[`FUTURE/docs/research/12-commercial-positioning.md`](../FUTURE/docs/research/12-commercial-positioning.md)
— is explicitly a proposal: line 3 says *"this is a proposal: no
interviews, pilots, purchases, revenue measurements, or license
clearance were conducted"*. No claims about customer demand,
revenue, or paid continuation are made by this decision record.

## 2. What this decision pins

The four boundary docs hold:

- [`docs/distribution.md`](distribution.md) — shipped tree + Linux-only
  packaging + unsigned-artifact statement + counsel-gate reminder.
- [`docs/security.md`](security.md) — local-only principal model +
  anti-self-approval + failure-code table + what MINIMAL does NOT do.
- [`docs/provider-economics.md`](provider-economics.md) — separation
  commitment + audit surfaces + enforcement-not-billing + portability.
- [`docs/runbooks/cancel-and-walk-away.md`](runbooks/cancel-and-walk-away.md)
  — operator's portability drill (backup → verify → diagnostics →
  restore + what does NOT transfer).

The supported prefix of MINIMAL 1.2.7 is unchanged from 1.2.6
(M9.5). No new code paths are introduced. The decision record
itself, the four boundary docs, and the regression tests that
guard them are the entirety of the M9.6 surface.

**No new commercial primitives are added:**

- No billing.
- No payment processing.
- No license-key validation or activation-token model.
- No multi-tenant principal model.
- No cryptographic signing of the release artifact.
- No package-manager packaging (deb / rpm / AppImage).
- No auto-update wiring (electron-updater / Squirrel / Sparkle).
- No hosted-execution surface.

## 3. Reversal criteria

The decision is reversible. Reversal requires **all three** of the
following:

1. **Cohort evidence.** At least one of the three experiment
   packages in research doc 12 lines 33-35 has met its go/no-go
   rule:
   - **Solo recovery and review** — at least 8 of 12 qualifying
     users used the package in both final weeks, 4 purchased
     continuation, and median human recovery/review time fell at
     least 25% against baseline without worse accepted-result
     quality.
   - **Owned-host routines** — 5 operators independently repeated
     at least 3 useful routines, 3 purchased continuation, and
     measured support projects below one staff-hour/operator/month
     while remaining profitable.
   - **Small-team adoption** — 2 teams bought maintenance, each
     had at least 2 people using the workflow weekly, and
     onboarding/support fit the quoted delivery budget.
2. **Counsel review.** The four research-doc gates at
   `FUTURE/docs/research/12-commercial-positioning.md:70-78` have
   been answered by counsel:
   - Artifact inventory for counsel (MINIMAL-authored +
     competitor-derived + provider binaries/SDKs + plugins +
     dependencies).
   - Provider confirmation (architecture, auth path, account
     owner, credential custody, billing flow).
   - Branding check (MINIMAL name + provider-name/logo usage).
   - Distribution/hosting model determination (especially any
     ELv2-derived hosted functionality).
3. **Separate milestone.** A future M-bullet (e.g. M9.7 or later)
   delivers the primitives the reversal requires — billing,
   license-key, multi-tenant principal, signing, package-manager
   packaging, or auto-update wiring — with its own gate test and
   its own release-notes entry. The reversal is NOT a casual undo.

Until all three are met, this decision record stands.

## 4. Support-cost model — explicit absence

**No support-cost model exists in code.** The research doc's
formula (`FUTURE/docs/research/12-commercial-positioning.md:43-44`):

> operating result ≈ N_paid × P × (1 − f)
>                    − F − N_active × c_variable − C_acquisition
>
> price floor = (F + N_active × c_variable + C_acquisition)
>               / (N_paid × (1 − f))

is a planning floor with no in-tree instantiation. There is no:

- Support queue or ticket model.
- Per-user cost ledger.
- Acquisition-cost tracker.
- Loaded-staff-cost-per-hour table.

A `Grep` across `src/` for `charge | payment | billing | subscription
| invoice | receipt` returns only test-stub comments in
`scripts/test-stub-provider*.mjs`. The formula is recorded in
research doc 12 as a *planning* aid, not as an in-tree system.

If commercialization is ever selected, instantiating this formula
would be a separate milestone.

## 5. Portability commitment

Quoting research doc 12 line 82 verbatim:

> Keep project files, already-created results, essential recovery,
> and export accessible after cancellation. Export readable
> task/recipe manifests, handoffs, artifact references, review
> evidence, and schema versions; exclude credentials. Document
> what cannot transfer, including provider-owned hidden state.
> Demonstrate import on a clean supported machine and continued
> access if MINIMAL's service disappears.

The four boundary docs + the cancel-and-walk-away runbook are the
M9.6 instantiation of this commitment:

- **What transfers:** `session`, `terminal`, `preset`,
  `env_profile`, `hook`, `launch`, `event`, `draft`, `meta` rows
  (per `src/runtime/db/backup.ts:114-119`); scrubbed operational
  logs via `npm run diagnostics:export`; project files (untouched
  by MINIMAL).
- **What does NOT transfer:** provider-owned hidden state
  (Codex/Claude accounts, conversations, cached inference);
  credentials; anything not in the 22-key allowlist.

The M9.6 cancel-and-walk-away runbook walks the actual backup →
verify → diagnostics → restore drill on a clean machine and
restates the "does NOT transfer" boundary verbatim.

## 6. Freshness rule

Every release bump re-validates this doc. The regression test at
`tests/docs/commercial-decision.test.ts` asserts:

1. This doc exists and contains the six required §-headings.
2. The doc references all four boundary docs
   (`docs/distribution.md`, `docs/security.md`,
   `docs/provider-economics.md`,
   `docs/runbooks/cancel-and-walk-away.md`) by relative path —
   guards against dangling pointers.

A future commit that flips the decision to "commercialization
selected" MUST:

- Bump the charter version (MAJOR).
- Update §1 with the new decision + the cohort evidence that
  triggered the reversal.
- Update §3 to record the reversal criteria as met.
- Add a new milestone section that lists the primitives added.

The test failure is the signal that the record is stale.

## See also

- [`docs/distribution.md`](distribution.md) — distribution + update-mechanism statement.
- [`docs/security.md`](security.md) — auth-rights statement.
- [`docs/provider-economics.md`](provider-economics.md) — separation commitment.
- [`docs/runbooks/cancel-and-walk-away.md`](runbooks/cancel-and-walk-away.md) — operator's cancellation drill.
- [`docs/release-notes-1.2.7.md`](release-notes-1.2.7.md) — release notes for this cut.
- [`FUTURE/docs/research/12-commercial-positioning.md`](../FUTURE/docs/research/12-commercial-positioning.md) — research doc 12.
- [`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md) — the M9.6 bullet (line 290).