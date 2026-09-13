# Final architecture review: coherence, completeness and staging

Review date: 2026-09-10. This pass reads the [master README](../../README.md), the [architecture contracts](../ARCHITECTURE.md), the [research record](../RESEARCH.md) and the prior specialist notes (01–14). It asks whether the proposal is internally coherent, whether each phase has the contracts it depends on, whether the deferred scope is explicit, and whether the instructions to the implementing agent are sufficient to begin. The application has not been built or run; no claim of implemented behavior is made.

This note is a review record. A finding remains useful evidence even if a subsequent phase corrects the proposal.

## 1. Coherence check against the master document

The master README states ten non-negotiable contracts, names the first product (a Linux/WSL task-to-review workflow for developers using Codex and Claude Code), commits to preserving ordinary terminals, defers team and hosted-execution products, and orders phases P0–P6. The architecture specifies process ownership, identities, persistence, recovery and acceptance. The research record indexes 15 specialist passes with a sourced ledger and explicit access limits.

The shape is consistent across these three documents. Each non-negotiable contract maps to a specific architecture section; each phase has a gate; each gate names the evidence it requires. No contradiction was found between the README's product decision and the architecture's ownership diagram. The deferred scope (full IDE replacement, collaborative editing, public marketplace, custom multi-agent framework, mandatory vector store, Kafka/Redis, multi-tenant hosted execution, automatic provider fallback, autonomous production deployment, mobile clients, unrestricted recursive spawning) is repeated consistently and is excluded from P0–P6.

Two cross-document adjustments are still owed:

- **P3 description vs P2 ownership.** The README's P3 says "Add separate managed workspaces, writer leases, parent/child tasks, bounded parallel admission, candidate integration and evidence review." The architecture's lease entity is marked "P3." The runtime review correctly notes that the lease cannot be deferred past the first managed writer: P2 already admits managed changes and promises one writer per checkout. The master plan should either move workspace leases into P2 or explicitly prohibit a second managed writer until P3 ships. This is a single-line scope clarification; it does not invalidate the staged ordering.
- **Host-local authority boundary.** The ADR 011 entry says "host-local authority with SSH-based remote transport later." The architecture's runtime socket is host-local; remote transport is a P5 addition. The README's owner-review section should call this out as the boundary the first paid tier cannot cross, so the buyer hypothesis in the commercial research matches the technical commitment.

These are not design defects; they are precision gaps that an owner decision closes in one paragraph each.

## 2. Contract inventory per phase

Each phase must enter with the contracts it depends on. The following table is a manual cross-check against the architecture and the runtime/security reviews; it is not a generated artifact.

| Phase | Required contracts before entry | Required evidence at gate | Source of contract |
| --- | --- | --- | --- |
| **P0 — recoverable baseline** | Application source recovered and inventoried; renderer/preload/IPC/file-provider controls reproduced; isolated profile tests passing | Baseline report links to actual code/tests; close/reopen does not replay commands; corrupt state remains recoverable; stale saves detected; acknowledged drafts survive restart; terminals/dialogs work by keyboard; packaged app runs without a global Node install | [README P0](../../README.md#p0--establish-a-recoverable-baseline), [architecture 1, 5](../ARCHITECTURE.md) |
| **P1 — runtime ownership and state migration** | Local runtime ownership model; one-writer profile lock; SQLite engine/binding selected; migration phases recorded; old-client incompatibility declared | Migration preserves IDs/presets/tombstones/drafts; duplicate runtime startup harmless; old versions cannot overwrite the new schema; restore tested with execution disabled; GUI crash does not own running terminals; status announcements usable across reconnect | [README P1](../../README.md#p1--extract-runtime-ownership-and-migrate-state), [architecture 1, 2](../ARCHITECTURE.md) |
| **P2 — managed single-agent workflow** | Task/run/invocation/artifact records; context bundles; grants; capability preflight; decision inbox; one version-tested provider adapter; bounded event spool | No duplicate prompt after GUI/runtime recovery; malformed output cannot complete a task; unknown provider version degrades visibly; permission denials effective; review refers to exact artifacts; loop demonstrated on a disposable real project | [README P2](../../README.md#p2--complete-one-managed-single-agent-workflow), [architecture 6, 7, 8](../ARCHITECTURE.md), [security review 2, 3](14-security-review.md) |
| **P3 — coordination and reuse** | Workspace leases; parent/child tasks; bounded parallel admission; candidate integration; capability manifests; configuration preview; recipes; MCP/hook import; handoffs | Parallel writers do not collide; initial user changes survive setup; stale acceptance rejected after a diff changes; failed tests block acceptance; changing provider shows unsupported settings | [README P3](../../README.md#p3--coordinate-work-and-reuse-setup), [architecture 2, 7](../ARCHITECTURE.md), [security review 3](14-security-review.md) |
| **P4 — automation and time** | Deterministic steps/dependencies; unique schedule occurrences; durable waits; retry classification; time-zone/misfire/overlap rules; history and triage | Clock/sleep/restart/DST fixtures do not duplicate work; schedules pauseable and auditable; queue cancellation responsive; budget displays distinguish estimates from enforced limits; no external mutation under stale approval | [README P4](../../README.md#p4--automate-predictable-work-and-handle-time), [architecture 9](../ARCHITECTURE.md) |
| **P5 — owned remote execution** | Host registration/identity; connection capabilities; remote filesystem/runner interfaces; environment templates; host-local scheduling; bounded synchronization; cleanup records | Network partitions preserve run identity; retries do not spawn replacements; cancellation uncertainty explicit; context export matches selected scope; credentials stay within intended boundary; abandoned resources remain visible; laptop-off test demonstrates any advertised remote scheduling guarantee | [README P5](../../README.md#p5--support-owned-remote-execution), [architecture 1](../ARCHITECTURE.md) |
| **P6 — paid release** | Onboarding; accessibility/keyboard; signed/staged releases; compatibility diagnostics; backups/export; support tooling; dependency/license attribution; update rollback | Commercial/auth rights reviewed; end-to-end workflow and recovery suite passes; no blocking usability issue; support/hosting costs have a plausible margin; real users return without prompting | [README P6](../../README.md#p6--qualify-the-paid-product-and-expand-selectively), [commercial positioning](12-commercial-positioning.md) |

The P0 gate is unusually heavy because the supplied snapshot already describes a working baseline with a verification record; that record is reproduced evidence, not yet fresh evidence. The first implementing agent's first task is to recover the source and re-run the listed checks under an isolated profile before any contract changes are made. This sequencing is consistent with the snapshot's own "engineering review targets" table and with the security review's P0 checklist.

## 3. Decision records cross-check

The architecture lists 13 ADRs, each with a decision, an alternative, and a revisit trigger. The following cross-checks were performed against the rest of the document set.

| ADR | Cross-check result |
| --- | --- |
| 001 Keep Codex/Claude as native agents | Consistent with [research 01](01-codex.md) and [02](02-claude-code.md). No new evidence contradicts it. |
| 002 Retain Electron/React/TS/tmux | Consistent with the supplied snapshot and with [research 06](06-environments-remote.md). The runtime review recommends a pinned Node runtime shipped alongside Electron; this is consistent with the architecture's "separately supervised local runtime" wording but warrants an explicit choice between Electron-main-only and a sibling runtime process. |
| 003 Separate local runtime and per-run transport | Consistent with the architecture's ownership table. The security review adds: the runtime socket must be excluded from the agent's mount namespace when restricted mode is selected. |
| 004 SQLite state plus artifacts and audit events | Consistent with the architecture's persistence section and the runtime review's storage gates. The actual binding/engine choice remains a P0 spike. |
| 005 Explicit run identity, dispatch intents, no implicit replay | Consistent with the runtime review's launch-deduplication section. This is a load-bearing contract; every replay test in P2, P3 and P4 references it. |
| 006 Structured CLI first; rich provider APIs capability-gated | Consistent with the architecture's adapter contract. The Codex app-server caveat in [research 01](01-codex.md) is correctly captured in the master README's "Recommended integration order" table. |
| 007 One writer per checkout, separate workspaces for parallel | Consistent with the runtime review's "ownership must exist before the first managed writer." P2 should adopt the lease entity or explicitly defer parallel writes. |
| 008 Typed capability catalog with pinned manifests | Consistent with the security review's supply-chain section. The catalog is curated and import/export-driven until a public marketplace decision is made. |
| 009 File/search-first context and explicit handoff artifacts | Consistent with [research 07](07-context-practice.md). Retrieval infrastructure remains deferred until a measured failure justifies it. |
| 010 Small local workflow state machine and scheduler | Consistent with [research 05](05-workflows-time.md). Temporal and similar platforms are explicitly deferred until measured local reliability cannot satisfy a validated requirement. |
| 011 Host-local authority with SSH-based remote transport later | Consistent with the deferred scope. The P5 gate covers the technical commitment; the commercial positioning note covers the buyer hypothesis. |
| 012 Grants and measured environment enforcement | Consistent with the security review's authority section. Restricted local mode and owned remote mode are both expected to gain environment-specific grants, not to inherit host defaults. |
| 013 Local supervised workflow before autonomous deployment/marketplace | Consistent with the deferred scope and the commercial positioning note's three experiment packages. |

No ADR is contradicted by the cross-document evidence. One ADR (003) could be sharpened to name the runtime-vs-Electron-main process boundary explicitly; one (007) requires P2 to either adopt the lease entity or defer parallel managed writes; the rest stand.

## 4. Documentation completeness check

The master README's "Reading guide" identifies three audiences (product owner, implementing agent, architect/reviewer). For each, the entry points exist:

- **Product owner** — sections 1, 3, 12, 15 of the README; the commercial positioning note for the paid hypothesis.
- **Implementing agent** — sections 4, 5, 12, 14 of the README; architecture sections 1, 2, 5; the runtime and security reviews for P0/P2/P3 gates.
- **Architect/reviewer** — ADR table in section 11; architecture contracts; research evidence.

Two documentation completeness items remain:

- **Glossary.** The architecture introduces entities (project, workspace, task, run, invocation, artifact, grant, dispatch intent, draft checkpoint, attention item, workspace lease, recipe version, capability installation, context bundle, schedule/occurrence) with brief definitions. A separate glossary would make the contracts easier to audit. This is a P0 housekeeping item; it does not block any phase.
- **Cross-reference index.** The research notes are linked from the master and from the architecture by section, but there is no single index of "every decision is challenged here." The decision-traceability table in the research record is the closest existing artifact. A short ADR-to-evidence index would close this gap.

## 5. Staging realism

The seven phases (P0 through P6) run from "recover and harden the baseline" to "qualify the paid product." Each phase ends at a reviewable gate. No phase is described in calendar time, team size or budget; the master README explicitly defers those to the owner decision. The risks per phase are reasonably bounded:

- **P0** is dominated by source recovery and reproducing the supplied checks. Failure mode: the snapshot's reported versions do not match the actual repository. Mitigation: P0 starts by inventorying the real source before changing anything.
- **P1** is dominated by SQLite/binding selection and migration safety. Failure mode: an atomicity assumption that does not hold on the actual storage (e.g., OneDrive mounted as the workspace). Mitigation: the runtime review's migration activation protocol and the architecture's "storage spike" gate.
- **P2** is dominated by selecting the first managed provider and shipping the run/review loop. Failure mode: a provider API or authentication change invalidates the chosen contract. Mitigation: capability-pinned adapter with visible degradation.
- **P3** is dominated by parallel ownership and reuse. Failure mode: two writers share a checkout. Mitigation: the runtime review's ownership-before-first-managed-writer correction.
- **P4** is dominated by time semantics and durable waits. Failure mode: schedules duplicate work across sleep/shutdown. Mitigation: the runtime review's time handling and the workflow/time research's Temporal/Trigger.dev references.
- **P5** is dominated by remote transport and host identity. Failure mode: a network partition spawns a replacement run. Mitigation: the runtime review's "dispatch algorithm" claim, repeated in the security review's authority section.
- **P6** is dominated by distribution and paid-product economics. Failure mode: enterprise expectations contaminate the personal-workspace offer. Mitigation: the commercial positioning note's three experiment packages and the deferred scope list.

Each phase has at least one explicit "no-go" condition (a phase gate that fails). The cumulative risk profile is acceptable for a staged delivery; it would not be acceptable as a single big-bang release.

## 6. What an implementing agent actually needs to begin

Section 14 of the master README enumerates twelve instructions. They are sufficient to begin, with three qualifications:

1. **Read the actual repository before changing it.** The supplied snapshot is reproduced evidence; the recovered source is the basis for any estimate. The instructions correctly say "start at the first incomplete phase" and "preserve unrelated edits, profiles, terminal identities and running work." They do not explicitly require reading every file; an implementing agent that skips ahead will misread ownership boundaries.
2. **Pin the provider/protocol contract against the user's installed version.** The research record explicitly notes that Codex app-server support wording is inconsistent and that subscription/authentication models have changed during 2026. The instructions say "recheck current provider/protocol documentation" but do not require a per-version spike record. The P2 gate references this implicitly through "demonstrate the loop on a disposable real project with authorized provider access."
3. **Resolve the P2 lease question before accepting a second managed writer.** The runtime review and the cross-document coherence check above both surface this. The instructions' "stop for new direction only when a material product choice prevents safe progress" applies; the implementing agent should ask rather than guess.

Adding "produce a short implementation plan naming files, state changes, failure behavior and acceptance evidence" (already in instruction 4) and "record compatibility versions, tests run and remaining risks" (already in the closing paragraph) closes the documentation loop. No additional master prompt is required.

## 7. Outstanding integration questions

These are questions the existing notes raised but did not fully resolve; each maps to a specific phase gate.

- **P0**: actual source, lockfile, packaged runtime, supported tmux version, OneDrive-vs-Linux storage behavior on the supported WSL distributions.
- **P1**: SQLite engine/binding selection; whether the active store must move off OneDrive; whether a stale lock file is unlinked or refused.
- **P2**: which native provider/version/authentication path passes the first managed-adapter spike; the canonical run/review artifact contract; the first recipe's evidence schema.
- **P3**: the precise manifest fields a capability must publish; the configuration-precedence UI; the recipe-import format.
- **P4**: the time-zone and misfire semantics for the first schedule; the durable-wait primitive; the retry-classification vocabulary.
- **P5**: the host-registration protocol; the SSH key/certificate handling; the remote cancellation acknowledgment contract.
- **P6**: the bundled-component license inventory; the compatibility-diagnostics payload; the support/runbook format.

None of these prevents producing a concrete design. They prevent presenting the proposal as an already-validated system.

## 8. Final disposition

The master plan is internally coherent. Each non-negotiable contract has a corresponding architectural enforcement. Each phase has an entry condition, an evidence gate and an explicit "no-go" condition. The deferred scope is consistent across documents. The decision records map to evidence without contradiction. The instructions to the implementing agent are sufficient for the first phase, with the three qualifications noted above.

Three corrections are recommended before implementation begins:

1. Move workspace leases into P2 or explicitly defer parallel managed writes until P3.
2. Clarify ADR 003 to name the runtime-vs-Electron-main process boundary explicitly.
3. Note in the master README's owner-review section that the first paid tier is host-local only.

The glossary and cross-reference index items are P0 housekeeping, not blockers. The research record's unresolved questions remain valid inputs to the relevant phase gates; the plan correctly avoids presenting them as solved.

This concludes the research record for the proposal. Future work begins at P0 under an explicit implementation instruction from the owner.

## Source ledger

All references above are internal to this workspace: the [master README](../../README.md), the [architecture contracts](../ARCHITECTURE.md), the [research record](../RESEARCH.md), and the prior specialist notes 01–14. No external sources were added in this pass. The plan remains a proposal; no claim of implemented behavior or measured performance is made here.
