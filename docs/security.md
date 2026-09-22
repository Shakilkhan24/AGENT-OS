# Authentication rights — what MINIMAL recognises as a principal

> **Status (M9.6):** boundary-pinning doc. Records the actual
> principal model as the M9.6 cut finds it. Not a legal
> determination. When the model changes (e.g. a remote-revocation
> path is added, multi-tenant is wired), update this doc and re-run
> the regression test that guards it — see
> `tests/docs/security-statement.test.ts`.

## 1. The principal model is local-only

Every `principal` string in the MINIMAL codebase is a local IPC
principal — never a remote user, never a third-party identity, never
a license-key holder. Three runtime surfaces carry principals:

- `src/runtime/db/grants.ts` — `grant.principal` is the requester
  of an authority grant. The doc-comment at line 13 says: *"the
  runtime derives the requester's principal from the authenticated
  connection"*. The "connection" is the local Electron IPC channel;
  it is not a network connection.
- `src/runtime/db/hook-activation.ts` — `activateHook` requires
  `principal === grant.decidedBy` (lines 198-201). The principal is
  the local user invoking the activation.
- `src/runtime/orchestration/lead-admission.ts` — lead proposals
  carry a `principal` (line 79 area, `MAX_GRANT_DEPTH = 4`). The
  principal is the local user who proposed the work.

There is no notion of a paid subscriber, a remote user, a third-party
identity, or a tenant. The principal string is the local IPC
principal — typically `"alice"`, `"bob"`, or `"system"` — typed by
the local user when they take an authority-bearing action.

## 2. Anti-self-approval rule

A grant cannot be approved by the requester:

- `src/runtime/db/grants.ts:107-108`:
  `if (parsed.decision === "approve" && parsed.decidedBy === requester)`
  → throws `AppError("CONFLICT", "Grants cannot be self-approved…")`.

The same rule cascades:

- `src/runtime/db/hook-activation.ts:198-201`: hook activation
  requires the `principal` to match `grant.decidedBy`, not
  `grant.principal` — so the requester cannot activate a hook they
  themselves approved.
- `src/runtime/orchestration/lead-admission.ts` (M5.2 trust model):
  child grants can only narrow parent grants (scope subset, expiry
  ≤, restrictions subset, digests subset, depth ≤ 4).

## 3. Failure codes are intra-runtime

`src/shared/errors.ts:failureSchema.code` enumerates the failure
codes the runtime can emit. The codes that bear on authorization
are:

| Code | Meaning | Source |
| --- | --- | --- |
| `FORBIDDEN` | Authorization refused | `grants.ts`, `hook-activation.ts`, `lead-admission.ts` |
| `LEASE_HELD` | Resource is held by another actor | `errors.ts:18-22` |
| `LEASE_UNCERTAIN` | Lease state cannot be determined | `errors.ts:18-22` |
| `CONFLICT` | Self-approval or state-machine violation | `grants.ts:107` |
| `NOT_FOUND` | Referenced row absent | `grants.ts:101` |
| `BUSY` | Global active-run cap tripped | `lead-admission.ts:75` |
| `BUDGET_EXCEEDED` | M9.5 refuse-to-spend gate tripped | `src/runtime/pilot/budget-gate.ts:166-171` |

All failures carry `correlationId` (UUID). None carry user identity
beyond the local `principal` string.

## 4. What MINIMAL does NOT do

- **No remote user.** The IPC principal is local; no remote-revocation
  path exists; no third-party identity is consulted at runtime.
- **No multi-tenant boundary.** There is no "tenant" concept;
  `delegationLimitsSchema` (`src/shared/delegation-schema.ts:132-156`)
  caps are user-local, not tenant-keyed.
- **No license-key validation.** There is no license-key store, no
  activation-token validator, no entitlement check at startup.
- **No remote-revocation path.** Local grants can transition to
  `expired` by local decision; nothing in the runtime consults an
  external authority.
- **No auto-update channel.** See `docs/distribution.md` §3.

If commercialization is ever selected, these boundaries would
change. See `docs/commercial-decision.md` §3 for the reversal
criteria.

## 5. Delegation limits

`delegationLimitsSchema` (`src/shared/delegation-schema.ts:132-156`)
carries runtime-internal caps:

- `globalMaxObservableNativeSubagents`
- `perInvocationMaxObservableNativeSubagents`
- `observableLevelsForCap`
- `perProviderMax*`
- `hardBudgetRequiredObservationLevels`

Defaults are `"fully-observed"` only; `"unobservable"` and
`"provider-internal"` are HARD-budgeted by default. None of these
caps are user- or tenant-keyed. The caps govern how much of the
native subagent's internal state MINIMAL is willing to admit into
its own audit trail — not who is allowed to invoke MINIMAL.

## 6. Freshness rule

Every release bump re-validates this doc. The regression test at
`tests/docs/security-statement.test.ts` asserts:

1. This doc exists and contains the four required §-headings
   (§1-§4 are the structural sections; §5/§6 are documentation-only).
2. `src/shared/errors.ts:failureSchema.code` still enumerates
   `FORBIDDEN` + `LEASE_HELD` + `LEASE_UNCERTAIN` (plus the M9.5
   `BUDGET_EXCEEDED`).

A future commit that adds new failure codes (e.g. `LICENSE_INVALID`
if commercialization is ever selected) MUST update both this doc
and the cited schema. The test failure is the signal.

## See also

- [`docs/commercial-decision.md`](commercial-decision.md) — the explicit no-commercialization record.
- [`docs/distribution.md`](distribution.md) — shipped tree + update-mechanism statement.
- [`src/runtime/db/grants.ts`](../src/runtime/db/grants.ts) — `requestGrant` / `decideGrant`.
- [`src/shared/errors.ts`](../src/shared/errors.ts) — `failureSchema.code`.
- [`src/shared/delegation-schema.ts`](../src/shared/delegation-schema.ts) — `delegationLimitsSchema`.