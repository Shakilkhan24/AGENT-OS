# MINIMAL architecture contracts

> **Planning update, 2026-09-13:** [The implementation roadmap](../IMPLEMENTATION-README.md) reconciles these contracts with the actual v1.2.1 source and the specialist reviews. Follow its milestone order and corrections, including write ownership before the first managed writer. The original research context and proposed contracts below are preserved for reference.

Design date: 2026-09-10. Status: proposed for review. This document specifies future behavior; it does not describe implemented features. The only supplied application evidence is [the build snapshot and request](../ins.md). File paths below are proposed boundaries, not files inspected in an application repository.

The [master README](../README.md) defines product scope and phase ordering. These contracts explain the difficult parts that an implementing agent must resolve. Build only the contracts needed by the current phase.

## 1. Ownership and process boundaries

Keep the existing Electron renderer, named preload bridge, TypeScript domain code, tmux execution foundation, and contained file provider. Introduce a separately supervised local runtime when managed runs begin. Electron main becomes the authenticated local client of that runtime; it continues to own native dialogs and desktop integration.

| Component | Owns | Must not own |
| --- | --- | --- |
| Renderer | Presentation, selections, in-memory editing, visible terminal subscriptions | Credentials, arbitrary filesystem access, execution authority |
| Electron main/preload | Validated UI requests, native capabilities, connection lifecycle | The lifetime of scheduled or managed work |
| Local runtime | Domain mutations, durable draft checkpoints, scheduling, admission, grants, reconciliation, SQLite connection | Model reasoning or a replacement agent loop |
| Per-run runner | One provider invocation, its pipes, bounded event spool, cancellation and deadline | Global configuration, unrelated runs, shared database writes |
| Codex / Claude Code | Native reasoning, tool loop, compaction, provider conversation | MINIMAL's final acceptance decision or global authority |
| tmux / execution backend | Persistent terminal ownership and process observation | Task completion semantics |
| File worker | Bounded, typed operations under pinned execution roots | Arbitrary host access for renderer requests |

The runtime is a modular application with a few necessary process boundaries, not a fleet of network services. Use a private Unix-domain socket in a verified owner-only directory. Frame and validate requests; cap sizes and outstanding requests. Verify peer identity where available. Bind all request scopes to the authenticated connection. Do not expose a public HTTP listener for the first local release.

A same-user host process remains part of the trusted local environment. Socket permissions alone do not isolate a hostile agent running as that same user. Isolated execution must exclude runtime sockets, its database, credentials, and configuration from the agent's mount namespace.

### Surviving GUI and runtime failure

The package needs a runnable runtime independent of Electron's window lifecycle. Proposed packaging choice: ship a pinned Node runtime and compiled TypeScript runtime/runner alongside Electron. Validate size, license notices, updates, and Linux architecture support in the packaging spike. Do not silently introduce a requirement for globally installed Node into the packaged application.

Use a user service where available, with a tested detached launch fallback. Autostart and starting at OS boot are separate settings. Do not change system service settings or enable lingering as an incidental side effect of opening the app. Microsoft documents WSL systemd support but says those services do not keep a WSL instance alive. Detect the actual installation and test its lifecycle; a user service does not establish always-on execution. [WSL systemd](https://learn.microsoft.com/en-us/windows/wsl/systemd).

Electron's run-as-Node behavior is fuse-controlled; packaging cannot disable that feature and also depend on it to launch the runtime. A detached child also needs independent file descriptors and lifecycle testing. These are reasons for the explicit runtime packaging decision. [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [Node child-process lifecycle](https://nodejs.org/api/child_process.html#optionsdetached).

For managed runs, a thin runner is launched under the execution backend, independently of the runtime connection. Initially, the existing private tmux server can anchor these runners. A runner owns provider stdio pipes; the UI never treats terminal text as an RPC stream. Its human-readable log and structured event stream are separate outputs. Reopening a view subscribes to an existing runner; it does not send the prompt again.

Runner control sockets are private and scoped to one invocation. Each command has an ID and a recorded result. Events have a runner incarnation and increasing sequence. The runner maintains a bounded local spool until the runtime durably acknowledges ingestion. The runtime is the only writer of the domain database. This spool is a transport recovery mechanism, not a second task database.

If a runner dies, provider resume is a new explicit invocation linked to the previous attempt. If provider survival or side effects cannot be established, mark the outcome unknown. Never interpret a missing process as proof that nothing happened. If the runtime disconnects, an already authorized runner may continue within its existing scope and deadline; new authority-dependent operations wait or fail closed. GUI closure, runtime crash, runner crash, host sleep, and OS shutdown require separate tests.

## 2. Identities and the minimum domain model

Do not rename every existing type immediately. Preserve legacy session and terminal UUIDs and introduce a documented mapping from the existing session to a project. A user can keep plain terminals without creating tasks.

| Entity | Meaning and important fields | First needed |
| --- | --- | --- |
| Project | Existing folder-bound session identity; name, original root, host, saved root identity | P1 |
| Workspace | Actual execution root; project, host, checkout, base commit, root identity, lifecycle | P2 |
| Task | Desired outcome; instructions, acceptance rules, owner, revision, status | P2 |
| Run | One execution attempt; task, provider, workspace, immutable input/config hashes, parent run, status | P2 |
| Invocation | A concrete OS/provider invocation; run, external session/turn IDs, process identity, version | P2 |
| Artifact | Manifest, report, diff, test result, log; content hash, producer, sensitivity, retention | P2 |
| Grant / approval | Authorized scope, requesting principal, action digest, expiry, decision and provenance | P2 |
| Domain event | Committed transition with cursor, aggregate revision, actor and cause | P1 |
| Dispatch intent | Durable request to create/stop an invocation; idempotency key and observed outcome | P2 |
| Draft checkpoint | Workspace/path, source version, draft revision and content reference | P0–P1 |
| Attention item | Task/run/reason/decision revision, unresolved state and separate read/snooze state | P2 |
| Workspace lease | One writer owner and generation for a managed checkout | P3 |
| Recipe version | Immutable workflow specification and required capability versions | P3 |
| Capability installation | Typed extension manifest, origin, digest, trust, enabled scope | P2–P3 |
| Context bundle | Selected sources, hashes/revisions, trust, budget, generated instruction references | P2 |
| Schedule / occurrence | Time policy and a uniquely identified intended firing | P4 |
| Host / environment | Execution identity, connection reference, capabilities and isolation declaration | P5 |

Runs and invocations are distinct so a documented deferred/resume flow can retain task history while making every process creation visible. A retry creates a new run; continuing a paused run may create a new invocation only under the same recorded continuation semantics. Neither may silently resend an ambiguous operation. A provider conversation ID is not a run ID, terminal ID, or acceptance result.

Store provider-specific references without pretending that Codex threads/turns and Claude sessions have identical semantics. Store observed facts separately from calculated status. PID alone is insufficient identity: combine host, boot identity where supported, start identity, backend namespace and invocation UUID.

### Persistence choice

Use SQLite for task state, dispatch intents, approvals and schedules; keep large logs and artifacts outside the database with hashes and a manifest. Use short transactions, foreign keys, explicit migrations, and bounded query results. Do not put raw terminal bytes into the domain-event table or rewrite the entire workspace for each event.

One dedicated database worker inside the runtime owns its connection and serializes writes. Process spawning, network calls, file recursion, and model execution happen outside transactions. Prefer ordinary current-state tables plus an append-only audit trail to full event sourcing. A transaction updates state, appends its event, and records any dispatch intent together.

SQLite WAL requires appropriate local filesystem semantics and has a single writer. Its current documentation also identifies a WAL-reset fix in 3.51.3 and selected backports. Use a patched engine, inspect the actually bundled version, and test checkpoint/disk-full behavior. Proposed durability setting: FULL for committed control decisions, measured before relaxation. [SQLite WAL](https://www.sqlite.org/wal.html).

Store the active database in a Linux-native profile location, outside project directories, Windows-mounted folders and sync folders such as OneDrive. This is a conservative support policy, not a claim that every Windows mount necessarily corrupts SQLite. An exported, consistent backup may be copied elsewhere. Do not silently move an existing custom profile: the baseline derives its tmux namespace from the profile path. Separate the stable execution namespace from the storage location during migration.

The SQLite binding is a P0 packaging decision. Current Node documentation marks `node:sqlite` release-candidate and describes synchronous methods; the snapshot's minimum Node version alone does not establish its usability. Compare the tested shipped Node/built-in combination with a maintained packaged binding, then record one supported choice. Do not add two drivers in production as a speculative abstraction. [Node SQLite](https://nodejs.org/api/sqlite.html).

Use the database backup API or another documented consistent snapshot operation. Copying only an open main database file is not the backup protocol. Exercise restore into an isolated profile with execution disabled. [SQLite backup](https://www.sqlite.org/backup.html).

## 3. State transitions, dispatch and reconciliation

Task states describe user work: `draft`, `ready`, `in_progress`, `blocked`, `review`, `accepted`, `cancelled`. A task reaches `accepted` only when its specified evidence and acceptance action exist. A successful provider exit can move it to `review`, never directly to accepted by inference.

Run states describe attempts: `queued`, `preparing`, `running`, `waiting_for_input`, `verifying`, `completed`, `failed`, `cancelling`, `cancelled`, `interrupted`, `unknown`. `completed` means this attempt finished with its declared output contract; it does not mean the task was accepted. Record stop reasons, not just a boolean.

| Situation | Required transition |
| --- | --- |
| Invalid configuration, missing auth, unsupported sandbox | Preparation fails before dispatch, with a recoverable explanation |
| Provider requests a permitted human decision | Running → waiting for input; approval bound to action and invocation |
| Provider supplies final result | Running → verifying; validate output and required evidence |
| Required verification fails | Failed attempt or task blocked; expose evidence and a deliberate retry action |
| Provider pauses with documented continuation | Waiting state plus exact resume reference; no implicit model call on reconnect |
| User requests stop | Cancelling until runner/host confirms termination; retain unconfirmed resources visibly |
| Connection disappears | Connectivity becomes unknown; execution state remains last observed, marked stale |
| Process absent after restart | Interrupted or unknown after reconciliation; never automatic success or automatic replay |
| External write times out | Unknown outcome until read-back or human reconciliation |

### Dispatch algorithm

1. Validate the request, current task revision, target host/root, provider capabilities and effective authority.
2. In one short transaction, reserve capacity, create the run and invocation intent, record the immutable manifest, and append an event.
3. Outside the transaction, dispatch with a stable invocation UUID to the owning execution backend.
4. The backend must reject or return the existing invocation for duplicate creation of that UUID. It must not start a second process under the same identity.
5. Persist the observed creation result. After a crash between steps 3 and 5, inspect that identity before deciding what to do.
6. If absence can be proven and the intent was never dispatched, dispatch it once. If the outcome remains ambiguous, block for reconciliation; do not guess.

This does not provide exactly-once effects for arbitrary commands. Shell scripts, package hooks, provider tool calls, and remote services can produce side effects before acknowledgement. External mutating operations need their own idempotency support or a read-back strategy. Retrying a failed status query and rerunning an arbitrary command are different policies.

Do not hold one global management lock for an entire batch. Serialize short state changes, then execute under bounded global/per-project/provider admission controls. A long launch, file operation or tool response must not prevent cancellation or reading the latest state.

## 4. UI synchronization and terminal semantics

The runtime returns a consistent snapshot with a durable event cursor and database generation. Clients subscribe from that cursor; stale aggregate revisions are ignored. Events are delivered at least once, and clients deduplicate. If retention removed the requested cursor or the database generation changes after restore, request a fresh snapshot.

Document the no-gap handshake: snapshot at cursor C, then replay all committed events after C before entering live delivery. Buffer or subscribe before snapshot capture if the transport implementation requires it. Never combine an unrelated snapshot and event listener and assume no transition can be missed.

Terminal byte streams use a separate protocol: `attachmentId`, generation, stream sequence and byte credit. Credits refer to encoded bytes, not JavaScript character count. Releasing a stale view cannot dispose of a newly mounted attachment. Output from inactive views must not traverse the renderer unless explicitly subscribed.

Start with one active attachment. Add an attachment registry before split views. Each view owns its dimensions, stream acknowledgement and input submission handle; accepted input belongs to the terminal-bound runtime queue. The run and terminal outlive those views. Define which view controls dimensions when the same terminal appears twice; default to a single designated interactive owner, with other mirrors read-only.

Large pastes belong to a terminal-bound input operation, not a React mount. Keep a bounded runtime-owned queue; show progress and explicit cancellation. Switching tabs continues accepted delivery to the original terminal. Cancelling reports bytes accepted by the bridge and bytes not sent. It cannot claim the shell or model consumed every acknowledged byte. Do not persist sensitive paste contents as ordinary audit events.

### Attention, focus and user actions

Attention items reference a task/run and decision revision. Their unresolved/resolved state is separate from read or snoozed presentation state. Preserve stable row selection while new items arrive. Background updates announce meaningful state politely without moving focus or reading terminal chatter. An expired decision remains inspectable but cannot execute. A notification click opens its item and never approves it.

Distinguish Reconnect, Answer request, Continue session, Start new attempt, Stop and Accept result. A view-close action only hides the view; an existing terminal-removal control explicitly means stop/remove and must retain that known consequence in its label. Retain managed run evidence after its view or terminal resource closes. Stop and delete-history are different operations.

Use manual tab activation where attachment incurs latency, predictable focus after tab closure, a discoverable command to leave terminal input, and remappable pane navigation. Dialogs return focus when dismissed and never interpret Escape as approval. Provide selectable accessible output and unified diffs. Splitters need keyboard control only when split views ship. Test the actual Linux/WSLg screen-reader path and report unsupported combinations. [UX contracts and primary guidance](research/11-ux-attention.md).

Only the explicit interactive owner can send input to a terminal; mirrors are read-only. Do not feed raw keystrokes into a managed provider's structured protocol. A human takeover uses a documented provider control or an explicit handoff between modes, with its authority and interruption effects recorded.

## 5. File safety and workspaces

The supplied snapshot identifies missing external-change protection. Add an expected content version to text saves before inviting concurrent agent editing. A read response includes root identity, relative path, file identity, content hash and bounded metadata. A save checks the expected version and reports a conflict instead of quietly accepting stale content.

Persist draft checkpoints outside project files, keyed by workspace, path, source version and draft revision. Acknowledge only after the checkpoint is durably stored. Restore the last acknowledged checkpoint as unsaved content; preserve both draft and externally changed source for comparison. Normal close flushes drafts; failed persistence offers save elsewhere, explicit discard or cancelled closure. A crash can only promise acknowledged checkpoints. Restored task prompts are never submitted automatically.

A hash check followed by rename is not an atomic compare-and-swap against arbitrary external writers. Require a managed workspace write lease for managed producers, watch for external changes, preserve a recoverable previous version, and document the remaining race in trusted-host mode. For isolation-grade writes, use an execution environment in which all writers are mediated or operate on an isolated snapshot and integrate a reviewed artifact.

Keep the existing descriptor-based containment rules and revalidate roots after worker recovery. Put a deadline, cancellation protocol, typed response schema and generation on every file request. Isolate slow jobs so one project cannot stall all projects. A timed-out mutation has an unknown/partial outcome until inspection; killing a helper is not rollback.

Iterate directory entries with bounded memory, paginate listings, and virtualize visible rows. Classify previews from headers and size before reading large content. Bound recursive operations and return per-item failures. Destructive cleanup needs an explicit target manifest; background retention must never recursively remove arbitrary project folders.

### Git ownership

Assign one managed writer per checkout. Parallel writers receive separate workspaces. Record base commit and initial dirty state. Do not stash, discard, commit, or reset a user's existing modifications as an invisible setup step.

By default, a new worktree starts from a chosen committed revision. Including uncommitted work is an explicit, inspected snapshot/patch operation. Worktrees share repository infrastructure; they are not security sandboxes. Give each environment separate ports and generated data where needed.

The default hooks directory is shared repository infrastructure. Serialize MINIMAL-managed changes to shared refs, worktree membership and repository configuration through a repository coordinator, and inspect effective hooks before Git mutations. Git's worktree lock protects lifecycle operations, not edit ownership. Native agent shell commands may bypass application coordination in trusted-host mode. [Git worktrees](https://git-scm.com/docs/git-worktree), [repository layout](https://git-scm.com/docs/gitrepository-layout).

Integrate through a candidate branch/worktree: inspect the candidate diff, run verification on the exact resulting tree, and obtain the required acceptance for that tree. Bind review to the diff/tree hash, base revision and evidence. Any content change invalidates that review. A passing test from another checkout or previous revision is not current evidence.

Promotion reacquires ownership and checks that the target still has the reviewed base. Use an atomic expected-old-revision operation where the destination supports one; a previous read alone leaves a race. A changed base requires a new integration candidate and applicable verification. Do not update a checked-out branch reference behind its working files or silently force-overwrite remote history. Capture relevant untracked/generated inputs and configuration in the verification receipt; Git tree identity alone does not describe all test inputs.

Support non-Git projects with single-writer operation and explicit file snapshots before managed changes. Do not silently initialize Git. Multiwriter non-Git merging is deferred.

## 6. Capabilities, grants and trust

Effective authority is the intersection of user/organization restrictions, project trust, environment isolation, task grant, and provider-enforced settings. Ordinary preference precedence cannot override a restriction. The effective-configuration view must explain each value and each denied request by its source.

An approval records principal, action type, normalized arguments, target identity, workspace/tree revision where relevant, capability version, request digest, expiry, and outcome. Reuse a valid existing grant within that exact scope. Re-prompt only for material changes or expiration. A model can request authority; it cannot grant itself authority.

| Execution mode | Honest guarantee |
| --- | --- |
| Trusted host | Normal user permissions; MINIMAL controls its own APIs, but arbitrary shell code may bypass those controls |
| Restricted local environment | Only the verified filesystem, process and network restrictions actually enforced by the backend |
| Remote environment | Restrictions enforced by that host; connection security and host capability checks remain necessary |

Do not call a worktree a sandbox. Do not claim an environment has network denial just because its template says so. Never mount the host container-engine socket, unrestricted home, credential directories or runtime socket into an untrusted environment by default.

Provider hooks and prompts are useful workflow controls, but shell access, plugins, setup scripts and MCP servers are all executable trust surfaces. Keep native provider restrictions active. Never use a hook as the only protection for a capability the provider may execute through another route.

For external writes, keep powerful credentials in an execution broker outside the agent environment where possible. The agent submits a typed action request; the broker checks a bound grant and current target before acting. Arbitrary cloud/admin credentials handed to a shell defeat that mediation.

Credential references may appear in manifests; credential values may not. Login remains provider-owned. Detect whether a supported secret store exists on Linux/WSL; a fallback plaintext file is not equivalent encryption. If secure persistence is unavailable, offer session-only use. Redact before logs, exports and telemetry. Users can inspect and revoke stored connections.

## 7. Context and extension contracts

A context bundle captures: objective, acceptance rules, workspace/base revision, selected source paths and hashes, source type, trust, freshness/expiry, exclusions, budget allocation, provider-specific instruction resolution, and outgoing-data policy. Record exact selected files or revisions, not an unlimited mutable directory reference. Label submitted inputs, provider-confirmed loading, later observed retrieval, and unknown native context separately. Observed additional reads append provenance records; absence of telemetry cannot prove that no other source was read.

Keep repository instructions, task instructions and retrieved source content distinct. Documents, MCP output, issue text and web pages are evidence, not authority. An embedded request to reveal secrets, install tools or expand scope is treated as content. Re-check grants for resulting actions.

Prefer selected files and ordinary search first. A vector index or external memory service requires a measured retrieval problem, deletion/refresh policy and data-boundary review. Do not upload repositories for indexing by default. Provider-native compaction remains provider-owned; MINIMAL stores explicit handoff summaries and artifacts without pretending they recreate hidden model state.

Instruction discovery, imports and memory sharing remain provider-specific. A second Git worktree does not establish independent provider memory. Detect/document that scope and use supported isolation controls when required; otherwise expose the limitation and avoid a cross-task memory-isolation promise.

An extension manifest distinguishes `skill`, `native-plugin`, `mcp-server`, `command`, `hook`, `script`, `context-source`, `environment`, and `recipe`. Each has an immutable ID/version/digest, provenance, compatible providers/platforms, dependencies, requested permissions, secret references, entrypoints and lifecycle/health policy. These kinds do not become interchangeable merely because they share a registry.

Installation is inspect → resolve pinned artifacts → review requested powers → install inactive → validate in a test scope → activate. No auto-update of active workflows to a mutable latest revision. Package installation and environment build scripts are executable actions and follow the same trust policy. Imported provider configuration must show unsupported fields and preserve user originals.

Runtime-owned workflow hooks use explicit event names and structured input, fixed deadlines/output limits, failure policy, idempotency classification and recursion limits. Native provider hooks retain their own documented semantics. Never globally replace a user's provider configuration to make a recipe work.

## 8. Time, budgets and remote continuation

Persist intended schedule occurrences separately from runs. Store the rule, IANA time zone, next UTC occurrence, enabled revision, overlap policy, lateness window and retry policy. A unique occurrence key prevents duplicate admission when two schedulers recover concurrently.

Default missed-run policy: skip and show the missed occurrence. Optional coalescing creates at most one catch-up run within a configured grace window. Catching up every missed interval is explicit and capped. For calendar rules, skip nonexistent daylight-saving local times and fire only at the first instance of a repeated local time. Keep interval timers distinct. Changes to time-zone data or rules recompute future previews under a new revision and preserve historical occurrences. Test clock adjustments, host sleep and cancellation before shipping schedules.

The runtime enforces global, per-project, per-provider and per-host concurrency limits. Child tasks consume the parent's allowance and have bounded depth; do not multiply nested parallelism without accounting. Explicitly separate admission concurrency, CPU/memory quotas, elapsed-time deadlines, provider quota and estimated spend.

Elapsed time uses a monotonic clock during one boot. Persist wall times, boot identity and state-transition durations for history; mark uncertain intervals after clock corrections or outages. Distinguish queued, agent-active, tool-active, waiting-for-user and disconnected time. Do not infer billable human time or agent effort from terminal existence.

A money budget is only a hard guarantee when the chosen provider/enforcement path can enforce it. Otherwise show an estimate and its lag, stop admitting work near the threshold, and report that in-flight spending can exceed it. Unknown usage is unknown, not zero. Do not silently switch providers when quotas are depleted: auth, data policy, behavior and cost would change.

Remote execution adds a host-side runtime with local storage and explicit capabilities. Use authenticated SSH transport initially; pin host identity and use a framed protocol rather than interpolated remote shell strings. Each run has one authority host. During a network partition, local UI marks state stale and reconnects by run/event cursor. It never starts a replacement locally because a remote host is unreachable.

Use a fixed installed helper or SSH subsystem and send task arguments as framed data. OpenSSH combines command arguments into a remote command line, so a local argument array does not by itself protect remote paths or prompts. Disable agent forwarding unless deliberately required. [OpenSSH command and forwarding behavior](https://man.openbsd.org/ssh.1).

If the laptop must be off while a schedule runs, its scheduler must reside on an available host. A remote terminal connection alone does not relocate scheduling. Avoid two schedulers owning one schedule; move ownership through an explicit handoff with a generation and fencing checks. Full multiuser distributed coordination is a later product with a different trust model.

## 9. Recovery and migration acceptance matrix

| Fault injected | Required evidence before the phase can pass |
| --- | --- |
| GUI killed during active run | Same invocation continues; reopened UI reconnects without another prompt |
| Runtime killed after launch dispatch, before save | Reconciliation finds one invocation; no duplicate command |
| Two runtime starters race | Exactly one domain owner; loser connects or exits without writing |
| Runner killed during a tool call | Unknown/interrupted outcome retained; no implicit replay |
| Duplicate or reordered provider events | Idempotent ingestion; invalid transitions rejected with diagnostics |
| Truncated JSON, huge frame, unknown event | Bounded memory; raw bounded diagnostic retained; adapter degrades visibly |
| Disk full while storing an approval/intent | No new unrecorded action dispatched; existing runs handled under explicit degraded policy |
| Disk full in runner spool | Stop admitting/producing unbounded output; retain failure marker and use declared stop policy |
| Provider auth/quota expires | Waiting/failed state with reason; no credential dumping or unauthorized fallback |
| Tab switched during Unicode paste | Original terminal receives accepted queue in order; progress/cancellation honest |
| Worker alive but hung | Deadline isolates affected request/project; other management remains responsive |
| File edited or root replaced externally | Conflict/root error; drafts and recoverable evidence retained |
| Remote disconnection during cancellation | UI says cancellation unconfirmed until host reconciliation |
| Restore from backup | New DB generation; old UI cursor rejected; all restored execution starts disabled pending reconciliation |
| Older GUI opens newer profile | Version refusal; no downgrade overwrite or schema reset |
| Update with existing tmux workers | Same stable namespace and UUIDs discovered; no relaunch |

### JSON-to-SQLite migration

1. Inspect the real source and schema; acquire the one-writer profile lock and stop metadata mutations.
2. Create a verified backup and a migration manifest with the source hash. Preserve invalid source data and stop; do not manufacture an empty profile.
3. Import into a new database in a transaction, preserving session/terminal IDs, root identity, timestamps, presets and tombstones.
4. Check counts, constraints and representative values; record the source hash and migration version.
5. Inspect the original tmux namespace without launching anything. Preserve its explicit identifier when changing profile storage location.
6. Atomically activate the new store, leave the old file recoverable/read-only, and prevent simultaneous use by an older app.
7. Reconcile surviving processes. Only after this can new writes or schedules be enabled.

Rollback before activation discards only the incomplete staging database. After new writes begin, rollback means restoring a consistent backup through a recovery tool; opening the old JSON file is not a lossless downgrade. Never dual-write the two stores indefinitely.

## 10. Implementation boundary map

Proposed destination structure; adapt to the actual repository after P0 inspection:

```text
src/
  shared/        versioned requests, events, capability and artifact schemas
  main/          Electron window, preload-facing IPC, native integration
  renderer/      project/task UI, attention inbox, review and terminal views
  runtime/
    domain/      project, task, run, approval and schedule transitions
    persistence/ SQLite schema, transactions, migrations and backup
    execution/   admission, dispatch, runner discovery and reconciliation
    providers/   Codex and Claude adapters plus a raw-terminal adapter
    context/     bundle selection, hashing, provenance and handoffs
    extensions/  manifests, resolution, activation and effective settings
    policy/      grants, trust and capability enforcement checks
    workspace/   Git checkout ownership, integration and environment lifecycle
  runner/        provider invocation, control socket, spool and stop handling
helpers/         existing contained filesystem and PTY helpers
tests/           domain, adapter, recovery, filesystem and packaged scenarios
```

Keep contracts close to their owners and avoid a generic plugin system for every internal function. Implement Codex and Claude separately behind a narrow capability interface; differences stay explicit. Keep terminal transport distinct from structured provider events. A renderer layout refactor cannot substitute for changing execution ownership.

## 11. Proposed service objectives

These are targets to test, not measured current performance. Record hardware, OS/WSL, filesystem, versions and workload for each result. Provider inference time and external-tool time are excluded only where explicitly stated.

| Scenario | Initial target |
| --- | --- |
| Visible response to an accepted UI action | p95 under 150 ms for local acknowledgement |
| Local cached workspace snapshot, 1,000 tasks/10,000 events | p95 under 250 ms |
| Cancellation command accepted by local runtime | p95 under 250 ms; execution stop measured separately |
| Switch terminal view in a 12-terminal fixture | p95 under 250 ms once attachment is ready; report reconnection separately |
| Idle app plus runtime, without providers/children | Establish baseline; proposed budget under 350 MiB RSS, clearly accounting for shared memory |
| Idle CPU on defined four-core fixture | Proposed sustained average under 2%; report total CPU convention |
| Reliability | 24-hour synthetic-output soak, 100 GUI reopen cycles, no duplicates or unbounded queues |
| Capacity progression | 1, 4, 12, 32 active runs; 128 retained terminal records; increase only after measurement |

Use the supplied 1,530 ms twelve-tab traversal only as historical snapshot evidence. It is not comparable to a new p95 per-tab benchmark without matching the fixture. Do not claim that provider processes fit the application memory budget.

Every release gate reports passed checks, failures, skipped checks and reasons. Do not substitute a green type check for process recovery, security containment, compatibility or user-workflow verification.

## 12. Proposed request and recipe shapes

The examples below are design sketches for future schemas. They are not existing endpoints, runnable recipes, real successful runs, or provider-native protocol messages. Finalize and version the schemas in the phase that implements them. Symbolic profile/command IDs must resolve to reviewed installed records before dispatch.

### A request to start managed work

```json
{
  "apiVersion": "minimal.control/v1-draft",
  "requestId": "request-example-001",
  "method": "run.start",
  "params": {
    "taskId": "task-example",
    "expectedTaskRevision": 4,
    "workspaceId": "workspace-example",
    "providerProfileId": "selected-native-profile",
    "inputManifestId": "manifest-example",
    "grantId": "grant-example",
    "idempotencyKey": "task-example-attempt-1"
  }
}
```

The authenticated connection supplies the principal. The runtime loads the referenced records, verifies scope and expected revision, computes authoritative manifest/action digests, and reserves capacity. Client-provided IDs and hashes never replace validation. A repeated key with the same canonical request returns the original handle; a repeated key with different input is a conflict. Preserve deduplication for the entire retry/recovery horizon.

An accepted response contains the run/invocation handles and a state cursor. Acceptance means the request is durably recorded, not that provider execution or the task succeeded. Error classes should distinguish `unsupported`, `conflict`, `forbidden`, `not_found`, `resource_exhausted`, `unavailable` and `unknown_outcome`; the UI must not treat every error as safely retryable.

### A committed event

```json
{
  "schema": "minimal.event/v1-draft",
  "cursor": {
    "databaseGeneration": "generation-example",
    "sequence": "184"
  },
  "type": "run.state_changed",
  "runId": "run-example",
  "revision": 3,
  "causeRequestId": "request-example-001",
  "data": {
    "previous": "preparing",
    "current": "running",
    "invocationId": "invocation-example"
  }
}
```

Use an encoding that preserves a large sequence value exactly. Keep provider sequence/incarnation separate from the database cursor. Events record committed facts and references; prompts, credentials and terminal bytes do not belong in generic event payloads.

### A bounded repair recipe

```yaml
schema: minimal.recipe/v1-draft
id: repair-failing-check
version: 1
inputs:
  project: project-handle
  objective: text
provider_profile: selected-native-profile
context_policy: project-selected-sources
workspace_policy: isolated-checkout
authority: existing-task-grant
limits:
  max_managed_parallel_runs: 1
  elapsed_deadline_minutes: 45
  automatic_agent_retries: 0
steps:
  - id: inspect
    kind: agent
    mode: inspect
    output_contract: investigation-report
  - id: implement
    kind: agent
    needs: [inspect]
    output_contract: candidate-change
  - id: verify
    kind: check
    needs: [implement]
    command_profile: project-approved-checks
    output_contract: check-evidence
  - id: review
    kind: approval
    needs: [verify]
    bind_to: [candidate-tree, base-revision, check-evidence]
outputs:
  - reviewed-candidate
```

The example's 45-minute deadline is an illustrative limit, not a duration estimate. The recipe can use two invocations of one native provider without requiring two simultaneous agents. An inspection profile must actually enforce its advertised restrictions. If implementation requests additional authority, the runtime creates a scoped decision; it does not increase the grant because the recipe says to implement. Already valid authority does not require repeated confirmation.

The verifier runs the reviewed command profile on the candidate tree and captures exit status plus required assertions. A passing command is insufficient if it ran no tests or evaluated another tree. If a fixture modifies its own tests or verification settings, show that explicitly. Review cannot advance on failed/missing required evidence. A report-only recipe may use an explicitly configured deterministic acceptance rule; code integration defaults to human review.

Long-lived development services are separate resources with readiness and stop policies, not finite command steps that magically complete when a process appears. A recipe can depend on a validated readiness result while the service continues under its own ownership.

### Result and handoff content

A result artifact needs a declared outcome (`ready_for_review`, `blocked`, or `failed`), task/run identity, candidate/base identity where relevant, produced artifact references, verification observations, known limitations and unresolved decisions. A handoff adds the last verified state, next intended action, active resources and authority remaining. All references resolve within the recipient's granted scope. No artifact can grant new authority merely by containing an instruction.

For deployments, additionally bind evidence and authorization to environment, artifact/plan digest, configuration revision, workflow revision and tool/provider versions. Recheck that tuple inside the privileged execution boundary. Saved-plan execution must consume the reviewed plan rather than regenerating it. Treat plan artifacts as potentially sensitive and record partial/unknown effects after interruption. [Git and DevOps research](research/08-git-devops.md).

### Retention defaults to validate in the pilot

Proposed starting values: retain domain history for 90 days and bounded raw provider/terminal diagnostics for 7 days; flag unaccepted candidate artifacts for retention review after 30 days. Keep accepted/pinned deliverables until the user removes them. Preserve minimal provenance and grant/intent records while any live run or retained artifact depends on them. Provide per-profile limits, visible disk usage and export before cleanup. These are product defaults for review, not legal retention requirements.

Cleanup only touches indexed application-owned artifacts or explicitly owned disposable environments. Never age-delete project files, active runs, pending approvals or the only recoverable candidate. Quotas stop new work or request a retention decision before silently destroying required evidence. The spool limit, log rotation, database event retention and artifact retention are separate settings with separate failure behavior.
