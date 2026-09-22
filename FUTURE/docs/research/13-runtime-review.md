# Runtime, storage and recovery review

Reviewed 2026-09-10: the proposed [master plan](../../README.md), [architecture contracts](../ARCHITECTURE.md), and supplied snapshot. No application source exists here; no runtime, migration, fault injection or provider execution was tested. Findings concern design contracts. They remain a review record if the integrating agent subsequently corrects the proposals.

The architecture is viable without another orchestration framework. Six corrections should precede implementation of the affected phase. Severity describes consequences of leaving the contract unresolved, not observed defects in running software.

## 1. High — launch deduplication must survive the runner

Architecture “Dispatch algorithm” requires duplicate creation to return the existing invocation, but a tmux name and a runner's memory disappear. Process absence cannot prove that an invocation never executed. An acknowledgement can be lost after effects occurred.

Minimal correction: before sending a launch, persist its dispatching state. The backend must exclusively claim the invocation UUID and immutable request digest in durable storage before spawning. Keep a compact launch receipt/result or tombstone through the permitted retry horizon. This is execution metadata, not another task database. An existing claim without a provable result means unknown; it cannot authorize another spawn. Expired identities must be refused rather than silently treated as fresh. A backend unable to provide this contract cannot enable automatic launch recovery.

Invariant/test: interrupt each boundary between intent commit, claim persistence, spawn and result acknowledgement. Repeated delivery creates at most one provider process for that invocation; ambiguous cases remain blocked. Test replay after the original process exits and after receipt retention expires. This does not promise exactly-once external effects.

## 2. High — process detachment does not establish the service boundary

systemd defaults to stopping all processes in a service's control group. [systemd kill policy](https://raw.githubusercontent.com/systemd/systemd/main/man/systemd.kill.xml). Node documents independent stdio requirements for background children; killing one process also need not kill its descendants. [Node child processes](https://nodejs.org/api/child_process.html#optionsdetached).

Inference: a tmux server first created inside the runtime's service can undermine the promised runner independence. Specify the actual backend/service scope separately from the runtime and verify it on cold startup and reuse. Do not resolve this merely by disabling service cleanup. Cancellation must identify its managed resource set and show surviving or unobservable children as unconfirmed.

Run the native-lifecycle comparison before committing to a custom runner: stable identity, observation after GUI/runtime loss, retained results, scoped stop and supported continuation are the acceptance criteria. Prefer the native path when it passes. A custom runner should own one invocation, despite the current “per-run” label. Pinned Node is a packaging candidate for the independent TypeScript runtime, not an already justified requirement of every invocation.

Invariant/test: restart the runtime service, kill the GUI, kill the runner, and inspect a provider with children separately. Existing work survives the first two; the latter cases never claim proven termination without evidence.

## 3. High — ownership must exist before the first managed writer

Architecture introduces workspace leases in P3, while P2 already admits managed changes and promises one writer per checkout. SQLite transaction serialization alone cannot choose the application's sole domain owner.

Minimal correction: hold one OS-backed profile lock for the runtime's entire ownership lifetime. Key its rendezvous to a stable profile identity independent of the relocated database path. Bind runner control/adoption to the current runtime generation and reject stale controls. Keep the lock's identity stable; do not solve stale startup by unlinking a potentially live lock file. Move basic workspace ownership to P2, or explicitly prohibit a second managed writer until it exists. P3 can add coordination between independent workspaces.

A missed heartbeat never releases checkout ownership while its previous writer might survive. An ownership token cannot fence arbitrary shell writes in trusted-host mode; unknown writers require reconciliation or another checkout.

Invariant/test: race two starters, reconnect an old controller after replacement, and interrupt a runtime while its provider still writes. Only one owner dispatches, and no replacement writer enters the uncertain checkout. Keep restored database generation distinct from runtime incarnation.

## 4. High — spool acknowledgement and disk exhaustion need a protocol

The bounded spool has no defined durable prefix, torn-tail handling or pressure policy. “Retain failure marker” cannot be unconditional when storage itself fails. Node's finite pipe buffers also make indefinite unread output a blocking condition. [Node pipe behavior](https://nodejs.org/api/child_process.html).

Minimal correction: frame spool records; identify them by invocation, runner incarnation and sequence; detect incomplete tails. Commit ingestion position, domain transition and audit event together before acknowledgement. Acknowledge only a contiguous committed prefix; duplicate identity with changed content is a protocol error. Delete acknowledged segments only after that boundary. Distinguish dispensable diagnostics from control/result evidence.

Set byte limits and a pressure threshold before exhaustion. Reserve control capacity where feasible, stop new admission, and apply an explicit backpressure/deadline/stop policy to existing work. If even the failure record cannot persist, recovery reports an unknown outcome. If disk flushes are batched, state the possible loss window; never acknowledge it as durable.

Invariant/test: lose acknowledgements, reorder/replay records, truncate a tail, fill storage, and fail a flush. Previously acknowledged facts remain recoverable; output is bounded; no missing final record becomes success. Cancellation remains responsive during pressure.

## 5. High — migration activation and recovery need durable boundaries

`rename` cannot cross mounted filesystems. [Linux rename](https://man7.org/linux/man-pages/man2/rename.2.html). File synchronization alone does not persist the containing directory entry, and synchronization can itself report exhausted storage. [Linux fsync](https://man7.org/linux/man-pages/man2/fsync.2.html).

Therefore “atomically activate” must describe staging and validation on the destination filesystem, then durable replacement of a small active-store locator there. Record recoverable migration phases; there is no single atomic switch spanning OneDrive and Linux storage. Preserve the legacy tmux namespace explicitly. Stop incompatible old clients before migration; read-only legacy JSON alone does not prove they cannot recreate or replace it.

SQLite's atomicity depends on storage behavior and preserves recovery metadata for a reason. [SQLite atomic commit](https://www.sqlite.org/atomiccommit.html). On suspected corruption, disable dispatch and preserve a coherent database/sidecar set before repair attempts. Never silently initialize an empty profile. Keep restore isolated with starts disabled.

SQLite integrity checking excludes foreign-key violations. [SQLite checks](https://www.sqlite.org/pragma.html#pragma_integrity_check). Enable foreign keys explicitly and validate both checks, plus application relationships. A recoverable export needs the consistent database snapshot, required referenced artifacts, hashes, schema version and profile/namespace metadata; pin those references during export.

Invariant/test: interrupt every migration phase; exercise failed directory synchronization, corrupt input, incompatible old-client startup and missing backup artifacts. Recovery selects one known store, retains evidence, and never replays restored intents automatically.

## 6. Medium — clarify retries, continuations and schema identities

The request example requires identical idempotency-key retries to return their original handle, while dispatch first checks current task revision. After the first accepted start increments that revision, those rules conflict unless ordering is explicit.

Minimal correction: authenticate and check scope, then resolve the scoped idempotency key and canonical digest before applying revision/admission checks to a new request. Different input under the same key is a conflict. Define uniqueness over principal/profile/operation/key and over invocation/incarnation/event-sequence; use non-null identity fields and foreign keys.

Separate `retryOfRunId` from the existing parent/child relationship. Record `continuationOfInvocationId` and its provider-supported resume reference. Reconnect creates neither a run nor an invocation. A supported continuation may retain its run; a retry creates another run even when it reuses a provider conversation. An invocation or inspection-step result must not complete a multi-step run. Preserve process facts separately from connectivity and semantic outcome.

Invariant/test: repeat an accepted request with its now-stale revision; obtain the same handle without another capacity reservation. Retry with changed input; obtain conflict. Continue a paused run; obtain a new invocation linked to that run. Complete only inspection in the repair recipe; the task remains unaccepted.

## Decisions that stand

Keep native agents, an independent domain owner, ordinary terminals, short database transactions, separate artifacts, generation-aware snapshot/replay, explicit unknown outcomes and evidence-bound acceptance. The patched SQLite/binding packaging gate, Linux-native control storage, consistent backup protocol and execution-disabled restore remain sound proposals. This review adds no production driver, service or framework.

All six distinct primary sources linked above were accessed on 2026-09-10. The systemd rendered manual returned HTTP 403; its official source was readable. Platform facts are bounded source summaries; the corrections and test cases are proposed design judgments. No claims of implemented schema enforcement or successful recovery tests are made.
