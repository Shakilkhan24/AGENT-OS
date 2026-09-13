# Durable workflows and time

Research date and access date for every linked source: **2026-09-10**. Scope: five systems, nine fetched official documentation pages. This is a design proposal, not implemented capability. The supplied foundation is Electron/TypeScript/tmux with JSON metadata; [the architecture contracts](../ARCHITECTURE.md) describe its proposed evolution.

## Evidence and decisions

Each observation below paraphrases the linked documentation. The borrow/defer column is an original MINIMAL recommendation. Documentation demonstrates contracts, not independently tested reliability.

| System and official source | Documented observation | Borrow / defer |
| --- | --- | --- |
| Temporal: [activity execution](https://docs.temporal.io/activity-execution) | Activity timeouts can cause retries. Receiving service cancellation requires heartbeats; an activity can ignore cancellation. Notification and human response can be separate operations. | Separate dispatch, observed completion and cancellation acknowledgement. Keep external effects outside state transitions. |
| Temporal: [schedules](https://docs.temporal.io/schedule) | A schedule has its own identity. Overlap policy and outage catch-up window are separate controls. Calendar schedules support named time zones. Pausing a schedule does not stop already started workflows. | Separate schedule, occurrence and run records. Expose overlap, lateness and pause semantics individually. |
| Trigger.dev: [wait overview](https://trigger.dev/docs/wait) | Waits support durations, dates and tokens. Cloud timed waits exceeding five seconds cease counting toward compute usage, but release concurrency only after snapshot/shutdown, documented at sixty seconds. | Distinguish a waiting workflow from occupied process capacity. Do not assume a paused CLI releases resources. |
| Trigger.dev: [idempotency](https://trigger.dev/docs/idempotency) | Deduplication depends on scope and TTL. Even globally scoped keys remain task/environment specific. Raw-string defaults changed in SDK version 4.3.1. | Make operation identity and deduplication lifetime explicit; never rely on a library default to protect side effects. |
| Inngest: [execution model](https://www.inngest.com/docs/learn/how-functions-are-executed) | Steps have stable identities and stored results. Subsequent execution reuses completed step outputs; failures can retry individual steps. Database/API operations belong inside step boundaries. | Persist completed outputs and recipe versions. A managed CLI invocation is a coarse step; MINIMAL cannot reconstruct every internal model/tool operation. |
| Inngest: [cancellation](https://www.inngest.com/docs/features/inngest-functions/cancellation) | Cancellation prevents future steps but does not interrupt an executing step. Cancelling existing runs does not prevent new runs from being queued. | Stop requests, schedule disabling and actual process termination need distinct controls and status. |
| Windmill: [suspend and approvals](https://www.windmill.dev/docs/flows/flow_approval) | Flows can await a configured number of approval events or cancellation, with optional timeouts. Resume URLs carry authority. Some approval forms and permission controls require Cloud/Enterprise. | Persist decisions and expiry; bind local approval to the exact action. Defer public approval links and team policy infrastructure. |
| Windmill: [concurrency limits](https://www.windmill.dev/docs/core_concepts/concurrency_limits) | Limits can span runs, use custom keys and time windows, and queue excess work. This feature is documented for Cloud and self-hosted Enterprise. | Model concurrent execution and requests per time window separately. Do not assume a platform's hosted feature set exists in its basic local edition. |
| n8n: [Schedule Trigger](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.scheduletrigger) | Scheduled workflows must be saved and published. Workflow timezone overrides instance timezone. Multiple trigger rules and cron expressions are supported. | Explicitly enable an immutable schedule revision and show its effective timezone. This page does not establish laptop wake or missed-run recovery guarantees. |

## Recommendation: local state first

Introduce the deterministic workflow controller when managed workflows are required, then scheduling in the time phase. Codex or Claude Code remains the installed planning/orchestration agent. The controller validates transitions and dispatches approved work; it contains no replacement model reasoning loop.

| Choice | Fit and cost for MINIMAL |
| --- | --- |
| Small state machine plus SQLite | Fits local ownership and offline use. Requires explicit crash recovery, migrations, admission and timer tests. Persist current state, audit events and dispatch intent transactionally. |
| Adopt an orchestration platform now | Supplies richer workflow machinery but adds a deployment, integration and failure boundary. It still cannot resolve arbitrary CLI effects or make a powered-off execution host available. |
| Integrate a platform later | Useful when users already operate one or require always-available remote jobs. Map start/status/cancel/approval capabilities explicitly and retain external run IDs. Assign one scheduler owner; never duplicate local and remote firing. |

Start with sequential command/installed-agent steps, validated results, durable waits and approval gates. Add bounded parallel groups only when needed. Defer general workflow programming, arbitrary replay, visual graph editors, distributed scheduling and platform hosting from the desktop MVP. Later candidates are Temporal for complex durable coordination, Trigger.dev/Inngest for application jobs, and Windmill/n8n for an existing organization's automation environment; these are fit assessments, not integrations selected or installed.

Persist recipe revision, input digest, completed step outputs, attempt lineage, deadlines and pending decisions. Use the run states already defined in the architecture contracts. A retry creates a new linked attempt; it does not erase the failed one. Stable logical operation keys survive retries, while invocation identities distinguish actual process starts.

A short transaction records state plus dispatch intent before launching outside the transaction. After a crash, reconcile the invocation identity and external receipt before dispatching again. A database commit cannot atomically cover an arbitrary shell command or remote API call. At-least-once delivery of an intent is not exactly-once external execution.

## Explicit failure and resource semantics

- **Retry:** Default arbitrary commands and coding-agent invocations to no automatic replay. Retry classified transient reads or operations with verified idempotency/read-back support, using capped exponential backoff, jitter, attempt limits and a total deadline. Authentication, permission and validation failures require intervention. Deduplication retention must cover the retry/backfill horizon.
- **Ambiguous effect:** If a write succeeds but its receipt is lost, record `unknown`, reconcile, and prevent dependent steps. Never infer failure from a timeout. Compensation is a separately authorized action that can itself fail; cancellation is not rollback.
- **Cancellation:** Persist intent, suppress new descendants, then ask the runner to stop gracefully. Escalate only against the verified owned invocation after its grace deadline. Remain `cancelling` while termination is unconfirmed. Record late results without admitting successors. Escaped child processes and remote effects require their own reconciliation.
- **Durable wait/approval:** Store wake time or decision request in SQLite, independent of a JavaScript promise or shell sleep. Bind approvals to principal, action digest, target/revision and expiry. Deduplicate repeated decisions; reject stale decisions. A timeout never grants approval. Reconnect resumes recorded state without resending the original prompt.
- **Concurrency:** Apply global, project, provider and workspace limits. A persisted wait can release execution capacity only after the corresponding work is quiescent. An open workflow still counts for schedule overlap. Keep its workspace lease, or reacquire it and revalidate the tree before continuing; do not hand its files to another writer silently.

A finite job has a completion/result contract. A development server, watcher or interactive agent session instead has readiness, health and explicit stop semantics. Its continued existence is neither job success nor evidence of useful work. Host reboot destroys live local processes; persisted workflow records enable reconciliation, not resurrection of tmux memory. An independently supervised runtime can continue when the GUI closes, but cannot execute while its host is asleep or off.

## Time policy proposed for MINIMAL

Store the schedule rule, IANA zone, enabled revision, next UTC occurrence, overlap policy and lateness window. Preview upcoming local times with UTC offsets. Default to simple daily/weekly schedules before exposing five-field cron. A timer only wakes the controller to inspect durable due records.

Choose and test explicit daylight-saving rules: skip nonexistent local times; for a repeated local time, fire only at its first occurrence and record the suppressed repeat. Keep interval schedules distinct from calendar schedules. Timezone/rule updates affect future occurrences and record a new revision; never rewrite historical firing times. A timezone-data update must trigger revalidation of future previews.

Default missed-run policy is **skip and report**. Optional catch-up coalesces eligible missed occurrences into at most one run within a configured grace window. Bulk backfill is explicit and capped. Default overlap policy is skip while the preceding workflow remains open; an optional one-item buffer is distinct from catch-up. Record why each occurrence ran or was skipped.

Use a unique `(schedule_id, revision, intended_utc)` occurrence identity and atomic admission to survive duplicate timer callbacks and backward clock adjustments. Use monotonic time for elapsed measurements during one boot and persisted UTC deadlines across restart. Re-evaluate deadlines on resume; show uncertainty in downtime duration rather than fabricating active-work time. Without an available host, do not promise on-time execution. Remote scheduling only helps when the required execution environment is also reachable.

## Five acceptance tests

1. **Dispatch crash:** Kill the runtime after process creation but before receipt persistence. Recovery discovers one invocation. Ambiguous external effects become `unknown`; no duplicate command is launched.
2. **Wait and approval recovery:** Restart during a timed wait and a human gate. Duplicate approval resumes once; expired or changed-action approval does nothing. An unapproved gate never advances after its deadline.
3. **Cancellation race:** Cancel immediately before and during an effect. Later steps never start. An unresponsive runner stays visibly unconfirmed; a completed external effect remains recorded.
4. **Calendar faults:** Simulate spring/fall DST changes, clock rollback, several missed intervals and host sleep. Verify skip/fold policy, unique occurrences, bounded catch-up and overlap independently.
5. **Admission and lifetime:** Saturate global/provider limits while a watcher and approval gate remain open. No workspace gets two writers; cancellation stays responsive; GUI reopening reconnects, while host reboot marks lost processes for reconciliation.
