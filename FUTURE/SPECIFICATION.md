# MINIMAL — Implementation Specification

> **Design reference, not the current execution checklist.** Read [IMPLEMENTATION-README.md](IMPLEMENTATION-README.md) first. Its design corrections supersede conflicting runtime, storage, lock, schema, authorization, testing and scheduling prescriptions below. File layouts, code sketches and day estimates remain proposals; check actual source and current provider documentation before using them. This specification predates the v1.2.1 baseline reconciliation.

**Document role.** This file preserves detailed implementation proposals alongside [`README.md`](README.md) (product rationale) and [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (architectural contracts). Its module layouts, schemas and tests are design input, not mandatory code templates. The [roadmap](IMPLEMENTATION-README.md) records which proposals to retain, correct, simplify or resequence against the actual build.

**Original research reading order, retained for reference after the roadmap:**

1. This file (read fully)
2. [`README.md`](README.md) §4, §5, §11, §12, §14
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §2, §5, §6, §7, §9
4. [`docs/research/13-runtime-review.md`](docs/research/13-runtime-review.md) and [`14-security-review.md`](docs/research/14-security-review.md) before P1, P2 and P3 — these are summarized as load-bearing rules in §13.1 and §13.2
5. The relevant research notes 01–06 when implementing §4.2 (native agent) features
6. [`docs/research/05-workflows-time.md`](docs/research/05-workflows-time.md) and [`07-context-practice.md`](docs/research/07-context-practice.md) for §4.7 (automation) and §4.4 (context)
7. [`docs/research/12-commercial-positioning.md`](docs/research/12-commercial-positioning.md) before P6, summarized in §13.3

**Foundational invariants carried over from the current codebase.** These are load-bearing; do not weaken any of them when implementing the new features.

| # | Invariant | Source in current code |
| --- | --- | --- |
| I-1 | Reconnect never replays or re-spawns | `Terminal.tsx` reconnect path; `LaunchCoordinator.recover()` only marks `state: cancelled` |
| I-2 | A terminal identity represents one launch; one UUID → one tmux session | `TmuxEngine.create` uses `minimal_${id}` |
| I-3 | A missing tmux pane is shown as missing, not auto-rerun | `Reconciler.status()` checks `live` then returns `"missing"` |
| I-4 | File paths are validated relative, no `..`, no NUL | `filePathSchema` in `src/shared/files.ts`, mirrored in `helpers/file_scope.py:parts()` |
| I-5 | Write carries an expected hash and re-checks before rename | `helpers/file_edits.py:save` |
| I-6 | State JSON commits use atomic temp + fsync + rename + dir-fsync | `src/main/atomic.ts` |
| I-7 | Only JSON commits share a queue (`Mutex`); engine and filesystem effects run outside it | `src/main/workspace-state.ts` |
| I-8 | The renderer is sandboxed, context-isolated, with `connect-src 'none'` and exact main-frame sender validation | `src/renderer/index.html`, `src/main/index.ts:trusted()` |
| I-9 | No shell interpolation in tmux argv; one argv array per command | `TmuxEngine.execute` via `python3 helpers/exec_clean.py tmux …` |
| I-10 | Deletion uses persisted tombstones and idempotent kills | `StopCoordinator`, v1.2 work log Change 6 |

Every new feature below must keep these intact or strengthen them.

---

## 1. Scope boundary

This specification covers the **v1.3 → v2.x feature set** planned in [`README.md`](README.md) §12 (P0–P6). It does **not** redefine P0 or P1; it describes them operationally so an implementing agent can execute them without re-reading every research note.

**Explicitly deferred** (copy of master README §12 scope list, kept here so implementers do not regress toward them):

Full IDE replacement · collaborative document editing · public plugin marketplace · custom multi-agent framework · mandatory vector database · Kafka/Redis infrastructure · multi-tenant hosted execution · automatic provider fallback · autonomous production deployment · mobile clients · unrestricted recursive agent spawning.

---

## 2. Target module layout

This is the destination structure, mapped to the actual files in the current repository. Adopt this incrementally; never large-bang-rewrite an existing module.

```
src/
  shared/                     — already exists; extend with new schemas
    types.ts                  — extend `API` and `Snapshot`
    models.ts                 — add v3 records; keep v1/v2 readers
    files.ts                  — extend `fileActionSchema` action union
    events.ts                 — extend `domainEventSchema` for tasks/runs/schedules
    settings.ts               — add the new settings groups
    engine.ts                 — extend `EngineAdapter` capability record
    commands.ts               — unchanged
    errors.ts                 — add new `Failure` codes already used ("RESOURCE_EXHAUSTED")
    hooks.ts                  — extend `action` union (already exists)
    env-profiles.ts           — extend with `inherit` semantics
    drafts.ts                 — extend `draftInputSchema` with `expectedHash`
    launch.ts                 — unchanged
    tasks.ts                  — new (P2)
    runs.ts                   — new (P2)
    recipes.ts                — new (P3)
    grants.ts                 — new (P2)
    bundles.ts                — new (P2)
    schedules.ts              — new (P4)
    attention.ts              — new (P2)
  main/                       — already exists; add coordinators and runtime
    index.ts                  — extend IPC handlers; no breaking changes
    service.ts                — unchanged facade shape; accepts runtime injection
    workspace-state.ts        — unchanged; SQLite-swap interface defined in P1
    store.ts                  — unchanged JSON in P0; behind feature flag in P1
    engine.ts                 — unchanged re-export
    tmux-engine.ts            — unchanged; still the only terminal transport
    filesystem.ts             — extend `resultSchemas` (already used for actions)
    settings-store.ts         — extend
    draft-store.ts            — extend
    atomic.ts                 — unchanged
    mutex.ts                  — unchanged
    logging.ts                — extend with audit sink
    event-bus.ts              — unchanged journal
    reconciler.ts             — unchanged terminal reconciliation
    launch-coordinator.ts     — unchanged launch
    stop-coordinator.ts       — unchanged stop
    stop-policy.ts            — unchanged
    process-tree.ts           — unchanged
    profile-runtime.ts        — unchanged
    pty-attachment.ts         — unchanged
    tmux-protocol.ts          — unchanged
    tmux-watcher.ts           — unchanged
    hooks.ts                  — new (P2) — wired into EventBus
    tasks/
      runtime.ts              — new (P2) — task/run/attempt lifecycle
      context.ts              — new (P2) — bundle assembly and provenance
      runner.ts               — new (P2) — owns per-invocation process identity
      spool.ts                — new (P2) — framed persistent spool
    providers/
      adapter.ts              — new (P2) — narrow contract
      codex.ts                — new (P2)
      claude.ts               — new (P3)
      schema.ts               — new (P2) — Zod codecs for known events
    grants/
      policy.ts               — new (P2)
      store.ts                — new (P2)
    recipes/
      runner.ts               — new (P3)
      catalog.ts              — new (P3)
    workspace/
      lease.ts                — new (P2/P3)
      git.ts                  — new (P3)
      provider-side/terminal.ts — unchanged reference
    scheduler/
      store.ts                — new (P4)
      triggers.ts             — new (P4)
      runner.ts               — new (P4)
    remote/
      identity.ts             — new (P5)
      ssh-transport.ts        — new (P5)
      capabilities.ts         — new (P5)
  preload/
    index.ts                  — extend with task/run/recipe/schedule methods
  renderer/
    main.tsx                  — unchanged
    App.tsx                   — split into AppShell + feature views (see §4)
    components.tsx            — extend `<Modal>` with `attention` variant
    useWorkspace.ts           — extend to subscribe to typed events
    TaskBoard.tsx             — new (P2)
    TaskDetail.tsx            — new (P2)
    RunStream.tsx             — new (P2)
    ArtifactViewer.tsx        — new (P2)
    Recipes.tsx               — new (P3)
    ScheduleEditor.tsx        — new (P4)
    AttentionInbox.tsx        — new (P2)
    HostsPanel.tsx            — new (P5)
    [existing views]          — Terminal.tsx, TerminalTabs.tsx, LaunchDialog.tsx, FilePanel.tsx, FileEditor.tsx, VirtualFileList.tsx, draft-mirror.ts — no breaking changes
helpers/
  filesystem.py               — extend with bundle-hash and worker cancellation paths
  bundle.py                   — new (P2) — content-addressed artifact store
  remote_fs.py                — new (P5)
  pty_bridge.py               — unchanged
  fds.py                      — unchanged
  exec_clean.py               — unchanged
  file_scope.py               — unchanged
  file_listing.py             — unchanged
  file_preview.py             — unchanged
  file_edits.py               — unchanged
tests/
  support.ts                  — extend with RuntimeDouble
  core.test.ts                — unchanged baseline; add new sections
  atomic.test.ts              — unchanged
  filesystem.test.ts          — extend with bundle-hash tests
  mutex.test.ts               — unchanged
  logging.test.ts             — extend with audit sink tests
  errors.test.ts              — unchanged
  event-bus.test.ts           — unchanged
  env-profiles.test.ts        — extend with inheritance tests
  hooks.test.ts               — extend
  draft-store.test.ts         — unchanged
  draft-mirror.test.ts        — unchanged
  tmux-protocol.test.ts       — unchanged
  tmux-watcher.test.ts        — unchanged
  tmux-engine.test.ts         — unchanged
  reconciler.test.ts          — unchanged
  launch-coordinator.test.ts  — unchanged
  stop-coordinator.test.ts    — unchanged
  stop-policy.test.ts         — unchanged
  process-tree.test.ts        — unchanged
  profile-runtime.test.ts     — unchanged
  store.test.ts               — extend with v2→v3 migration
  settings-store.test.ts      — unchanged
  workspace-state.test.ts     — unchanged
  python-helpers.test.ts      — extend for `bundle.py`
  desktop.spec.ts             — extend scenario count
  package-smoke.ts            — unchanged
  tsconfig + package.json     — add `better-sqlite3` in P1 only (otherwise no change)
docs/
  build-snapshot-v1.1.md      — keep as historical baseline; do not delete
  build-snapshot-v2.0.md      — new, written at end of P3
  architecture.md             — extend in P1 with SQLite, in P2 with task model, in P4 with scheduler
  verification.md             — extend with each phase gate's test record
```

**Rule.** Implementers add files in the marked places; existing file boundaries must remain until they have a deprecation plan.

---

## 3. Phases and gates

Each phase ends with a single reviewable gate. Gates are not calendar-bound; they require reproducible evidence.

### P0 — Recoverable baseline (no new feature work, only hardening)

**Goal.** Bring the existing source state to the point where the v1.1 verification record can be reproduced on the actual repository.

**Tasks**

1. Open the current repository; verify `package-lock.json`, `dist/`, `release/`, and `helpers/` match the snapshot's stated versions in [`build-snapshot-v1.1.md`](../docs/build-snapshot-v1.1.md).
2. Run `npm ci && npm run check` in an isolated `MINIMAL_DATA_DIR`; record results.
3. Run `npm run test:desktop` and `npm run test:package`; record results.
4. Document any drift between snapshot text and actual repository in a new file `docs/build-snapshot-drift.md`.

**Gate evidence**

- `docs/build-snapshot-drift.md` exists or the note "no drift" is recorded.
- All P0-listed items in [`docs/research/14-security-review.md`](docs/research/14-security-review.md) §7 have a passing unit/integration test reference.
- OneDrive filesystem path receives a specific note in the storage selection step of P1.
- Acknowledged drafts survive a forced `kill -9` of the GUI during a mid-debounce cycle (new test).

**Out of scope for P0** — any new module or capability listed in §5. P0 modifies only test files, build configuration, and documentation.

### P1 — Runtime ownership + SQLite migration

**Goal.** Replace the JSON state with a SQLite database owned by a separately-supervised local runtime process; preserve every existing ID and behavior.

**Tasks**

1. Create `src/main/tasks/` and `src/main/remote/` directories as empty markers (full implementation in P2/P5).
2. Add a small `LocalRuntime` interface next to `EngineAdapter`:

   ```ts
   // src/main/tasks/runtime.ts (P1 — interface only)
   export interface LocalRuntime {
     start(): Promise<void>;
     close(): Promise<void>;
     identity(): RuntimeIdentity;          // path + generation + nonce
     owns(): boolean;                       // one-writer profile lock
     request<T>(method: string, params: unknown, options?: { timeoutMs?: number; idempotencyKey?: string }): Promise<T>;
     subscribe(filter: DomainEventFilter, listener: (event: DomainEvent) => void): () => void;
   }
   export interface RuntimeIdentity { profilePath: string; generation: string; nonce: string; startedAt: string; }
   ```

   P1 implements only the skeleton: `LocalRuntime.start` acquires a `flock(LOCK_EX | LOCK_NB)` on `<profile>/runtime.lock`; failure exits the process; close releases the lock and flushes WAL.

3. Pick SQLite binding through a spike:

   - `better-sqlite3` (synchronous, predictable for desktop) is the recommended default because it pairs naturally with the existing `WorkspaceState.mutex` and survives OneDrive syncs better than async Node bindings.
   - Reject any binding that requires native compilation without prebuilt binaries for the supported architectures.
   - Document the chosen engine in `docs/architecture.md` §2.

4. Schema design (SQLite, all timestamps stored as ISO 8601 text, all UUIDs as text):

   ```sql
   CREATE TABLE schema_migrations (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL,
     source_hash TEXT NOT NULL,
     notes TEXT
   );
   CREATE TABLE state_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   );
   -- Existing v2 tables (sessions, terminals, presets, env_profiles, hooks, launches, drafts, settings, event_journal)
   -- carry their existing JSON contents under a single `payload` column with a `kind` discriminator for the v3 migration window.
   CREATE TABLE v2_legacy (
     kind TEXT PRIMARY KEY,
     payload TEXT NOT NULL,
     migrated_at TEXT
   );
   ```

5. Migration algorithm — follow [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §9 acceptance matrix verbatim, with these specifics:

   - One-writer profile lock first; refusal if another instance holds it.
   - Read `state.json` and `events.json`; backup both content-addressed by SHA-256 prefix to `profile/legacy/<digest>.json` before any write.
   - Import inside one SQLite transaction; abort on any validation failure; never auto-create an empty profile.
   - Refuse to open a profile whose JSON contains a v3 schema ID until the migration runs.
   - On migration failure, the old files remain untouched and the new DB is moved aside as `profile/failed-v1-migration-<digest>.sqlite`.

6. Lifecycle: the runtime is a separately-spawned process only if packaging becomes a problem; otherwise it remains a module loaded by `SessionService` with the same `LocalRuntime` interface.

**Gate evidence** — all items in [`README.md`](README.md) P1 gate, plus:

- A second instance started while the first holds the lock exits non-zero within 200 ms.
- Profile reopened after `kill -9` of the owning process is refused by lock contention; if lock file is removed manually, recovery tool requires an explicit operator decision.
- `state.json` from v1.1 + `events.json` from v1.2 work log import into SQLite without loss; sample tests cover 13 sessions, 64 terminals, 3 hooks, 50 launches, 200 events.

### P2 — Managed single-agent workflow

**Goal.** Land the "fix a failing test" workflow end to end against one pinned native provider version.

**Tasks — schema additions** (extend `src/shared/`):

1. `tasks.ts` — Zod schemas for `Task`, `Attempt`, `Run`, `Invocation`, `Artifact`:

   ```ts
   export const taskStateSchema = z.enum(["open", "preparing", "ready", "running", "waiting", "reviewable", "accepted", "rejected", "cancelled", "failed", "blocked"]);
   export const taskSchema = z.object({
     id: z.string().uuid(),
     workspaceId: z.string().uuid(),
     title: z.string().min(1).max(140),
     objective: z.string().max(8000),
     constraints: z.array(z.string().max(500)).max(16).default([]),
     acceptance: z.array(z.string().max(500)).max(8).default([]),
     state: taskStateSchema,
     revision: z.number().int().nonnegative(),
     createdAt: z.string().datetime(),
     updatedAt: z.string().datetime(),
     tags: z.array(z.string().min(1).max(40)).max(20).default([]),
     parentTaskId: z.string().uuid().optional(),
     correlationId: z.string().uuid(),
   });
   export const attemptSchema = z.object({
     id: z.string().uuid(),
     taskId: z.string().uuid(),
     sequence: z.number().int().nonnegative(),
     providerProfileId: z.string().uuid(),
     recipeId: z.string().uuid().optional(),
     grantId: z.string().uuid(),
     idempotencyKey: z.string().min(1).max(128),
     startedAt: z.string().datetime().optional(),
     endedAt: z.string().datetime().optional(),
     outcome: z.enum(["pending", "running", "succeeded", "failed", "cancelled", "expired", "unknown"]).default("pending"),
     notes: z.string().max(2000).default(""),
   });
   export const runSchema = z.object({
     id: z.string().uuid(),
     taskId: z.string().uuid(),
     attemptId: z.string().uuid(),
     invocationId: z.string().uuid(),
     state: z.enum(["queued", "preparing", "starting", "running", "paused", "stopped", "finished", "errored"]),
     providerId: z.string(),
     providerSessionId: z.string().optional(),
     hostId: z.string().optional(),                // empty until P5
     lastEventCursor: z.string(),
     startedAt: z.string().datetime().optional(),
     endedAt: z.string().datetime().optional(),
     tokenUsage: z.object({ input: z.number().int().nonnegative().default(0), output: z.number().int().nonnegative().default(0), cached: z.number().int().nonnegative().default(0) }).default({ input: 0, output: 0, cached: 0 }),
   });
   export const invocationSchema = z.object({
     id: z.string().uuid(),
     runId: z.string().uuid(),
     incarnation: z.number().int().positive(),
     processTreePid: z.number().int().positive().optional(),
     spawnedAt: z.string().datetime(),
     endedAt: z.string().datetime().optional(),
     disposition: z.enum(["spawned", "ready", "exited", "abnormal", "unknown"]),
     lastAcknowledgedPosition: z.number().int().nonnegative(),
   });
   export const artifactSchema = z.object({
     id: z.string().uuid(),
     kind: z.enum(["diff", "log", "report", "bundle", "binary", "transcript", "manifest", "checkpoint"]),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().nonnegative(),
     createdAt: z.string().datetime(),
     provenance: z.array(z.object({ source: z.string(), at: z.string().datetime(), action: z.string() })).max(64),
     scope: z.object({ workspaceId: z.string().uuid(), taskId: z.string().uuid().optional(), runId: z.string().uuid().optional() }),
     path: z.string().max(4096),                   // resolved within profile artifacts dir
     expiresAt: z.string().datetime().optional(),
   });
   ```

2. `grants.ts` — explicit authority records:

   ```ts
   export const grantScopeSchema = z.object({
     workspaceId: z.string().uuid().optional(),
     taskId: z.string().uuid().optional(),
     paths: z.array(z.string().max(4096)).max(128).optional(),
     actions: z.array(z.string().min(1).max(80)).max(64),
     networks: z.array(z.string().regex(/^[a-z0-9.-]+$/)).max(32).optional(),
     tools: z.array(z.string().min(1).max(80)).max(64).optional(),
     secrets: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(64).optional(),
   });
   export const grantSchema = z.object({
     id: z.string().uuid(),
     principal: z.object({ kind: z.enum(["user", "system", "hook"]), id: z.string() }),
     scope: grantScopeSchema,
     actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
     createdAt: z.string().datetime(),
     expiresAt: z.string().datetime().optional(),
     revokedAt: z.string().datetime().optional(),
     provenance: z.string().max(1000),
   });
   ```

3. `bundles.ts` — context bundle receipt:

   ```ts
   export const bundleComponentSchema = z.discriminatedUnion("kind", [
     z.object({ kind: z.literal("intent"), title: z.string().max(140), body: z.string().max(8000), constraints: z.array(z.string().max(500)).max(16).default([]) }),
     z.object({ kind: z.literal("acceptance"), rules: z.array(z.string().max(500)).max(8) }),
     z.object({ kind: z.literal("sources"), entries: z.array(z.object({ path: z.string().max(4096), digest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().max(500) })).max(200) }),
     z.object({ kind: z.literal("instructions"), entries: z.array(z.object({ name: z.string().max(200), digest: z.string().regex(/^[a-f0-9]{64}$/), observed: z.enum(["loaded", "submitted", "unknown"]) })).max(64) }),
     z.object({ kind: z.literal("continuation"), handoffDigest: z.string().regex(/^[a-f0-9]{64}$/), decisions: z.array(z.string().max(500)).max(64) }),
     z.object({ kind: z.literal("accounting"), bytes: z.number().int().nonnegative(), tokenEstimate: z.number().int().nonnegative().optional(), exclusions: z.array(z.string().max(200)).max(32) }),
   ]);
   ```

4. `events.ts` — additional event variants (extending the discriminated union, never removing existing variants):

   ```ts
   base.extend({ type: z.literal("task-created"), data: z.object({ taskId: z.string().uuid(), state: taskStateSchema }) }),
   base.extend({ type: z.literal("task-state-changed"), data: z.object({ from: taskStateSchema, to: taskStateSchema, reason: z.string().max(200) }) }),
   base.extend({ type: z.literal("run-state-changed"), data: z.object({ from: runSchema.shape.state, to: runSchema.shape.state, position: z.number().int().nonnegative() }) }),
   base.extend({ type: z.literal("artifact-stored"), data: z.object({ artifactId: z.string().uuid(), digest: hashSchema }) }),
   base.extend({ type: z.literal("grant-issued"), data: z.object({ grantId: z.string().uuid(), scope: z.string().max(500) }) }),
   base.extend({ type: z.literal("grant-revoked"), data: z.object({ grantId: z.string().uuid(), reason: z.string().max(500) }) }),
   base.extend({ type: z.literal("attention-required"), data: z.object({ kind: z.enum(["decision", "review", "failure", "stale", "unknown"]), reference: z.string().max(500) }) }),
   ```

   The `at` field is preserved; `seq`/`correlationId` rules remain unchanged.

5. `attention.ts` — typed inbox entries:

   ```ts
   export const attentionItemSchema = z.object({
     id: z.string().uuid(),
     kind: z.enum(["decision", "review", "failure", "stale", "unknown"]),
     summary: z.string().min(1).max(280),
     reference: z.object({ kind: z.enum(["task", "run", "attempt", "approval", "schedule", "host"]), id: z.string() }),
     createdAt: z.string().datetime(),
     seenAt: z.string().datetime().optional(),
     resolvedAt: z.string().datetime().optional(),
     resolution: z.string().max(500).optional(),
     revision: z.number().int().nonnegative(),
   });
   ```

**Tasks — `src/main/tasks/`**

1. `runtime.ts` — implements `LocalRuntime` operations over SQLite. Use `Mutex(64)` per existing pattern.
2. `context.ts` — build bundles from a task + capability profile + handoff. Persist with `bundleSchema`; never write secrets into bundles.
3. `runner.ts` — owns one invocation's process identity:

   - Tracks `invocationId`, `incarnation`, `lastAcknowledgedPosition`.
   - Honors `StopPolicy` from `src/main/stop-policy.ts` via `engine.stop`.
   - Persists a checkpoint before spawning; refuses to spawn when a non-expired identical claim exists for the same `idempotencyKey` with a different `actionDigest`.
   - Uses a Unix-domain socket at `<profile>/runtime.sock`; framed JSON-RPC with sequence numbers and per-frame ack; refuses connections from non-owner peer UIDs.

4. `spool.ts` — framed spool for raw provider events (bounded size, rotated, indexed by `(invocationId, sequence)`):

   ```ts
   export interface SpoolFrame {
     seq: number; invocationId: string; provider: string; recordedAt: string;
     kind: "data" | "control" | "exit" | "ack" | "error";
     payload: Uint8Array;                              // bounded per payload kind
   }
   ```

   Commits ingestion cursor and domain transition together before acknowledging a frame. Reject duplicate `seq` with different content. Retain failed frames with their diagnostic marker; do not discard them invisibly.

5. Hooks in `src/main/hooks.ts` (NEW) — wire existing `Hook[]` schema to event bus; emit only on event match; never call hooks synchronously inside a JSON commit.

**Tasks — `src/main/providers/`**

1. `adapter.ts` — narrow contract based on `EngineAdapter` philosophy:

   ```ts
   export interface ProviderAdapter {
     readonly id: string;
     readonly capabilities: ProviderCapabilities;
     detect(): Promise<{ installed: boolean; version: string; auth: AuthState }>;
     prepare(profile: ProviderProfile): Promise<PreparedContext>;
     invoke(spec: InvocationSpec, callbacks: InvocationCallbacks): Promise<Invocation>;
     continue(spec: ContinueSpec, callbacks: InvocationCallbacks): Promise<Invocation>;
     stop(invocation: Invocation, policy: StopPolicy): Promise<StopReport>;
     inspect(invocation: Invocation): Promise<ProviderObservation>;
   }
   export interface ProviderCapabilities {
     structured: boolean; live: boolean; approvals: boolean; resume: boolean; subagents: boolean; usage: boolean; sandbox: boolean; background: boolean;
   }
   ```

2. `codex.ts` — implements the contract against `codex exec --json` per [`docs/research/01-codex.md`](docs/research/01-codex.md). Pin to a specific version range; record the resolved version in the run record. Defer `app-server` to P3.
3. `schema.ts` — Zod codecs for the JSONL stream emitted by Codex.
4. The renderer's `LaunchDialog` API is **not** removed. Existing terminal launches continue to use `TmuxEngine` directly. Provider dispatch is a separate code path.

**Tasks — `src/main/grants/`**

1. `policy.ts` — `canPerform(principal, grant, request): { allowed: boolean; reason?: FailureCode }`. Refuses actions whose `actionDigest` does not match the issuing grant. Refuses scope widening in parameters.
2. `store.ts` — persisted grant records; revocation is a state change, never a delete.

**Tasks — renderer additions**

1. Split `App.tsx` into:
   - `AppShell.tsx` — composition root, sidebar, layout state.
   - `useWorkspace.ts` — extends to subscribe to `attention-required`, `task-state-changed`, `run-state-changed`.
   - `TaskBoard.tsx`, `TaskDetail.tsx`, `RunStream.tsx`, `ArtifactViewer.tsx`, `AttentionInbox.tsx`.
2. `RunStream.tsx` reuses the existing xterm.js setup via a thin wrapper; structured events are rendered inline as plain text, never as ANSI codes, to keep the existing "agent != terminal" separation in invariants.
3. `ArtifactViewer.tsx` reuses the existing preview pipeline; binaries are streamed and shown via `data:` URLs in the same way `FilePanel` does already.
4. New preload methods:

   ```ts
   listTasks(filter?: { state?: TaskState[]; workspaceId?: string }): Promise<TaskView[]>;
   getTask(id: string): Promise<TaskDetail>;
   createTask(input: TaskInput): Promise<TaskView>;
   startAttempt(taskId: string, input: AttemptInput): Promise<AttemptView>;
   resolveAttention(id: string, decision: { accept?: boolean; notes?: string }): Promise<void>;
   requestGrant(input: GrantRequest): Promise<GrantView>;
   inspectRun(runId: string): Promise<RunView>;
   listArtifacts(scope: { runId?: string; taskId?: string }): Promise<ArtifactSummary[]>;
   readArtifact(id: string): Promise<ArtifactView>;
   ```

**Gate evidence** (P2):

- A disposable project with one test file; one task "fix this failing test" creates a Task → launches a Codex attempt → Codex edits the file → confirms acceptance by running the project's test command → emits `task-state-changed: reviewable` with artifact list; user accepts from inbox.
- A duplicate `startAttempt(taskId, { idempotencyKey: "abc" })` after the first succeeded returns the same handle without spawning a second process.
- A run whose provider returned no final result (`outcome = unknown`) is recorded and never auto-retried.
- Permission denial test: a tool call whose `actionDigest` is outside the issuing grant returns `Failure("FORBIDDEN")` and is recorded, not silently executed.
- Review of the diff refers to the **exact** `candidate-tree` digest stored in the artifact record; tampering with the file system between review and acceptance invalidates the reviewed-version flag.

### P3 — Coordination, recipes, contexts

**Goal.** Multiple managed writers in separate workspaces; reusable recipes; explicit handoffs.

**Tasks**

1. Add `src/main/workspace/lease.ts` — workspace lease table in SQLite with `(workspaceId, generation)` keying. Owner field reads from the runtime identity; allows rotation only when previous heartbeat is older than the lease TTL plus clock-skew budget.
2. Workspace lease must already exist when P2 admits a managed writer (per [`docs/research/13-runtime-review.md`](docs/research/13-runtime-review.md) §3 — correct this proactively even though the existing README defers it to P3).
3. `src/main/recipes/runner.ts` — deterministic step machine with kinds: `agent`, `command`, `check`, `approval`, `artifact`. Each step has `inputs`, `outputs`, `timeout`, `retry classification`, `requires`, `bindTo`.
4. `src/main/recipes/catalog.ts` — typed catalog with import/export. Pins to manifest digest per [`docs/research/04-protocols-extensions.md`](docs/research/04-protocols-extensions.md). A diff between an installed version and the pinned version is shown before promotion.
5. `src/main/workspace/git.ts` — checkout integration:
   - Acquire a worktree from a pinned base commit; record `generation` and acquire `lease`.
   - Detect effective hooks (`.git/hooks/*`) at dispatch time; refuse to run if hooks present unless recipe has explicit `accept-host-hooks: true` grant.
   - On acceptance: verify the **exact** `candidate-tree` digest matches the diff artifact; refuse acceptance if not.
6. Capability manifests — extend `src/shared/hooks.ts` schema's discriminated union; add `Command`, `Script`, `McpServer`, `Skill`, `Recipe` kinds (each with its own manifest fields, no single shared shape).
7. Cross-provider handoff — record a handoff as an `Artifact` with `kind: "checkpoint"` + `kind: "transcript"` references and an `Artifact` of `kind: "manifest"` describing the contents. The receiving provider receives manifest contents only.

**Gate evidence** (P3):

- Two writers in two separate worktrees never share a checkout; a manual `git mv` between them is detected and reported as an external change.
- A recipe that authorizes an `apply: terraform` step requires an explicit `grant`; if no grant exists the runtime records a pending approval and does **not** invoke the command.
- Editing a recipe creates version 2; existing schedules still execute the previous version; promotion requires a deliberate act and a diff.
- A cross-provider handoff does not embed the previous provider's transcript; only the manifest and a bounded summary.

### P4 — Automation, time, and durable waits

**Goal.** Deterministic schedule execution; bounded retries; resume after sleep/shutdown.

**Tasks**

1. `src/main/scheduler/store.ts` — table `schedules` + `occurrences`. Each schedule has `(id, revision)`, IANA timezone, overlap policy (default `no-overlap`), misfire policy (default `skip`), lateness window.
2. `src/main/scheduler/triggers.ts` — admits a unique `occurrenceId`. Resolving `nextFireAt` must handle DST unambiguously and refuse to admit a missed catch-up run that would skip more than the configured grace window.
3. `src/main/scheduler/runner.ts` — wraps a `Recipe` against the existing `Task` graph. Records `Start`, `Finish`, `Missed`, `Aborted` rows; surfaces missed occurrences as `attention-required` items.
4. Persistent waits — extend recipe step kind `wait` with `until: "duration" | "approval" | "external-event"`. The store records the wait as a row; a separate admission path resumes on expiry.
5. Retry classification — vocabulary: `idempotent-read`, `idempotent-write-verified`, `unknown-effect`. Default = no auto-retry. Capped exponential backoff with jitter; attempt bound visible.
6. Budget — show estimated provider spend + a hard cap that is **only** enforceable if the chosen provider supports it; otherwise show "estimated, not enforceable" prominently.

**Gate evidence** (P4):

- Clock test: simulate a 2-hour sleep across DST; only one occurrence fires, at the new UTC time, no duplicates.
- A recipe with `requires: ["check"]` does not start until the check step is acknowledged by its own commit.
- A retry classified `unknown-effect` is recorded; the user is asked to confirm before re-dispatch.
- A schedule advertised to run while the laptop is off must show "no available host" — never claim it ran.

### P5 — Owned remote execution

**Goal.** SSH-based remote host registration with owned-host scheduling.

**Tasks**

1. `src/main/remote/identity.ts` — host record with public-key fingerprint, capabilities (filesystem, runner, scheduler, environment), last-heartbeat.
2. `src/main/remote/ssh-transport.ts` — uses the existing `helpers/exec_clean.py` pattern: a fixed installed remote helper served over SSH, framed JSON-RPC, owner verification on the host side. Disable agent forwarding by default.
3. `src/main/remote/capabilities.ts` — discover and refresh host capabilities; never interpolate remote command strings; only the framed payload carries arguments.
4. The desktop client becomes a client of the host runtime for managed work. Local runs continue to work normally for tasks not requiring a remote host.
5. Update `helpers/filesystem.py` with `helpers/remote_fs.py` to mount remote roots via the framed transport; preserve `openat2`-equivalent containment on Linux hosts.

**Gate evidence** (P5):

- Network partition during an active run is reflected as `attention-required: stale`; reconnect by event cursor; no replacement spawn.
- A failed SSH key rotation invalidates the host record and refuses dispatch.
- A remote cancellation is shown as "unconfirmed" until the host acknowledges.

### P6 — Paid release

This phase is **operational**, not architectural. Tasks:

1. License inventory of bundled components; SPDX-style `THIRD_PARTY` file.
2. Installer path (deb/rpm/AppImage), staged atomic update.
3. Accessibility & keyboard pass against the existing app — at minimum, every existing `dialog`, `tab`, `row`, `form-field` keeps its labels and roles; add `aria-busy`, `aria-live` to the new task board.
4. Pricing experiments per [`docs/research/12-commercial-positioning.md`](docs/research/12-commercial-positioning.md) §"Three experiment packages".
5. Backup/export/import — backup is a saved `runtime.lock`-less snapshot of the SQLite database + artifacts directory + a metadata file listing pinned provider/protocol versions.
6. Release signing per platform; reproducible pipeline.

---

## 4. Detailed implementation recipes (per feature)

This section expands §3 with **implementation-level directives** for each feature in scope. Each subsection lists:

- The exact files to create or modify.
- Type definitions to add (referencing §3 schemas).
- New IPC channels to expose.
- New renderer components.
- Test additions (where they live, what they assert).

### 4.1 Task & attempt lifecycle (P2)

**Files:** `src/shared/{tasks,runs,attention}.ts`, `src/main/tasks/{runtime,context,runner,spool}.ts`, `src/main/hooks.ts`, `src/preload/index.ts`, `src/renderer/{TaskBoard,TaskDetail,RunStream,AttentionInbox}.tsx`, `src/shared/types.ts`.

**IPC additions** (in `API`):

```ts
listTasks(filter?: TaskFilter): Promise<TaskView[]>;
getTask(id: string): Promise<TaskDetail>;
createTask(input: TaskInput): Promise<TaskView>;
transitionTask(id: string, expectedRevision: number, next: TaskState, reason: string): Promise<TaskView>;
startAttempt(taskId: string, input: AttemptInput): Promise<AttemptView>;
cancelAttempt(attemptId: string, policy: StopPolicy): Promise<StopReport>;
listAttention(filter?: { kind?: AttentionKind[]; open?: boolean }): Promise<AttentionItemView[]>;
resolveAttention(id: string, resolution: AttentionResolution): Promise<void>;
```

**Implementation directives**

- Transitions are validated by `(id, expectedRevision)` to prevent stale UI updates from corrupting state — same pattern as `WorkspaceState.update`.
- `startAttempt` is idempotent on `(taskId, idempotencyKey)`; the second invocation returns the first handle. Different `input` under the same key returns `Failure("CONFLICT")`.
- The runner persists a dispatch intent (`run.start` row) **before** spawning. A startup recovery that finds a `run.start` row without an associated live process treats it as `unknown` and asks the user; it never auto-respawns.
- Hooks (`src/main/hooks.ts`, NEW) wire to `EventBus`; they are dispatched after the bus persists the event, never inside the bus mutex.
- `AttentionInbox.tsx` reuses `Modal` from `components.tsx`; rows are navigable by j/k keys; dismissal requires the same verb that's exposed in the row's context menu.
- The "Start" button on `TaskDetail` triggers a preflight that resolves the provider profile and lists its capabilities; missing capabilities are displayed inline before dispatch.

**Test additions**

| File | Assertion |
| --- | --- |
| `tests/tasks/runtime.test.ts` | `transitionTask` rejects stale revisions |
| `tests/tasks/runner.test.ts` | idem-key deduplication across reincarnation |
| `tests/tasks/runner.test.ts` | `unknown` outcome is recorded when receiver exits before first event |
| `tests/spool.test.ts` | duplicate `seq` with different bytes is rejected |
| `tests/hooks.test.ts` | hook that throws does not block event persistence |

### 4.2 Provider adapters (P2 — Codex; P3 — Claude)

**Files:** `src/main/providers/{adapter,codex,claude,schema}.ts`, `tests/providers/*`.

**Adapter contract** (from §3): `ProviderAdapter` is the published surface.

**Codex adapter directives**

- Read `codex --version` once at session start; record on each run.
- Stream JSONL with line-delimited JSON; use a single `AsyncIterable<CodexEvent>` parser. The schema lives in `src/main/providers/schema.ts`.
- Map events to domain events:
  - `{"type": "thread.started", "thread_id": ...}` → persist `providerSessionId`.
  - `{"type": "turn.started", ...}` → `run-state-changed: running`.
  - `{"type": "item.completed", "item": { "type": "agent_message", "text": ... }}` → store as artifact if `kind: "transcript"`, otherwise as log.
  - `{"type": "turn.completed", "usage": {...}}` → record token usage; emit `run-state-changed: finished`.
  - `{"type": "error", ...}` → emit `attention-required: failure` with structured payload; outcome is `unknown` until next event clarifies.
- Persist a final-result marker before `close()`; missing marker ⇒ `outcome: unknown` and a single user-visible `attention-required` entry.

**Claude adapter directives** (P3)

- Use `claude --print --input-format stream-json --output-format stream-json` per [`docs/research/02-claude-code.md`](docs/research/02-claude-code.md).
- `--permission-prompt-tool` integration: route approvals through MCP tool `minimal_request_approval(grantId, actionDigest, payload)`.
- Treat `--defer` hooks as the **first** gate, but never the only gate; keep runtime-level grants as a hard backstop.

**Cross-provider directives**

- Capability snapshot per provider is shown in the user-facing detail; missing capabilities degrade visibly, not as silent no-ops.
- Provider-installed CLIs are assumed configured by the user; MINIMAL does not read credential files.

### 4.3 Grants (P2)

**Files:** `src/shared/grants.ts`, `src/main/grants/{policy,store}.ts`, IPC + renderer additions.

**Behavior**

- A `Grant` is always created in response to a user action; automatic creation is forbidden.
- Each tool call carries an `actionDigest` derived from the canonical JSON serialization of the request payload (see `LaunchCoordinator.canonical` for the existing pattern).
- `policy.canPerform` walks the principal's grants in `createdAt` order; first matching grant whose `expiresAt` has not passed and whose `scope` covers the action returns `{ allowed: true }` plus the grant ID; otherwise returns `{ allowed: false, reason: Failure["code"] }`.
- Revocation sets `revokedAt`; revocation is observable; an operation already admitted before revocation is reported as "completed; recorded retroactively revoked".

**Test additions**

| File | Assertion |
| --- | --- |
| `tests/grants/policy.test.ts` | scope widening in parameters is rejected |
| `tests/grants/policy.test.ts` | match by actionDigest fails on collisional inputs |
| `tests/grants/store.test.ts` | revocation is observable across all open runs |

### 4.4 Bundles & handoffs (P2 + P3)

**Files:** `src/shared/bundles.ts`, `src/main/tasks/context.ts`, `helpers/bundle.py`.

**`helpers/bundle.py`** is a small helper that computes content-addressed digests and stores blobs in `profile/artifacts/<digest-prefix>/<digest>` using O_NOFOLLOW + fsync. Refuse to dedupe identical content under the same digest with different provenance.

**Receipt model**

A bundle receipt records:

- `selected` — what MINIMAL prepared.
- `submitted` — what was sent to the provider.
- `provider-confirmed loaded` — what the provider loaded (only what its docs expose; otherwise `unknown`).

The receipt lives next to its artifact and is **never** persisted with secret material.

### 4.5 Recipes (P3)

**Files:** `src/shared/recipes.ts`, `src/main/recipes/{runner,catalog}.ts`, `src/renderer/Recipes.tsx`.

**Schema shape** (sketch):

```ts
export const recipeStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent"), id: z.string(), providerProfileId: z.string().uuid(), needs: z.array(z.string()).default([]), input: z.string(), outputContract: z.string(), timeoutMs: z.number().int().min(1000).max(86_400_000), retryClass: z.enum(["idempotent-read", "idempotent-write-verified", "unknown-effect"]).default("unknown-effect"), maxAttempts: z.number().int().min(1).max(8).default(1) }),
  z.object({ kind: z.literal("command"), id: z.string(), needs: z.array(z.string()).default([]), command: z.string().max(8192), cwd: z.string().max(4096), outputContract: z.string(), timeoutMs: z.number().int().min(1000).max(86_400_000) }),
  z.object({ kind: z.literal("check"), id: z.string(), needs: z.array(z.string()).default([]), command: z.string().max(8192), cwd: z.string().max(4096), requires: z.array(z.string().max(500)).max(16), timeoutMs: z.number().int().min(1000).max(86_400_000) }),
  z.object({ kind: z.literal("approval"), id: z.string(), needs: z.array(z.string()).default([]), bindTo: z.array(z.string()).min(1), message: z.string().max(1000) }),
  z.object({ kind: z.literal("artifact"), id: z.string(), needs: z.array(z.string()).default([]), kind$: z.string(), outputContract: z.string() }),
  z.object({ kind: z.literal("wait"), id: z.string(), needs: z.array(z.string()).default([]), until: z.discriminatedUnion("kind", [z.object({ kind: z.literal("duration"), ms: z.number().int().min(1000) }), z.object({ kind: z.literal("approval"), approvalId: z.string() }), z.object({ kind: z.literal("external-event"), topic: z.string().max(200) })]) }),
]);
export const recipeSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().positive(),
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  inputs: z.record(z.string().min(1).max(80), z.unknown()).default({}),
  steps: z.array(recipeStepSchema).min(1).max(64),
  grants: z.array(z.string().uuid()).default([]),
  limits: z.object({ maxParallelism: z.number().int().min(1).max(64).default(1), deadlineMs: z.number().int().min(60_000).max(7 * 86_400_000) }),
});
```

**Implementation directives**

- A recipe run uses `WorkspaceState.update` only for `RecipeRun` rows; engine dispatch happens outside the mutex.
- Approval step blocks until `(current user action)` records a `Grant` whose `actionDigest` matches the bound digest.
- Revisions are immutable; pinning a recipe to a task stores the version ID, not the name.

### 4.6 Attention inbox (P2)

**Files:** `src/shared/attention.ts`, `src/main/hooks.ts` (NEW), `src/renderer/AttentionInbox.tsx`.

**Rule.** Every event that requires a user decision emits exactly one `attention-required` event with an `AttentionItem` payload. The inbox lists those items. Reading the inbox or dismissing a row **does not** authorize anything.

### 4.7 Schedules (P4)

**Files:** `src/shared/schedules.ts`, `src/main/scheduler/{store,triggers,runner}.ts`, `src/renderer/ScheduleEditor.tsx`.

**Behavior**

- Resolving a recurring rule emits a new `ScheduleOccurrence` row with `(scheduleId, revision, occurrenceId)`. The trigger admission looks for an active occurrence with the same key; one admission wins, others are recorded as `coalesced`.
- Misfire = `now > expectedFireAt + latenessWindow`. Default action: skip with row recorded.
- DST: rule resolution must use IANA timezone; nonexistent local times (DST spring forward) are skipped; ambiguous local times (fall back) are validated against the policy (`fire-once` vs `fire-both`).
- Persisted user-visible timezone; a schedule shows both local time and next UTC fire.

### 4.8 Hosts (P5)

**Files:** `src/shared/hosts.ts`, `src/main/remote/{identity,ssh-transport,capabilities}.ts`.

**Identity verification** uses host public-key fingerprints; the recorded fingerprint is matched against the server's advertised key on every connection. Any mismatch is recorded as `attention-required: stale` and the connection is refused.

### 4.9 Paid release (P6)

**Files:** distribution scripts (`scripts/package.mjs`, new `scripts/sign.{deb,rpm,appimage}.mjs`), `THIRD_PARTY`, `LICENSES/`.

---

## 5. Test strategy

The baseline test stack (`tests/core.test.ts`, `tests/desktop.spec.ts`, `tests/package-smoke.ts`, `tests/python-helpers.test.ts`) is already comprehensive for the v1.1 features. Each phase adds targeted tests **without rewriting the existing ones**; the gate evidence requires both old and new tests to pass.

| Layer | Already exists | Add in P2 | Add in P3 | Add in P4 | Add in P5 |
| --- | --- | --- | --- | --- | --- |
| Domain (node:test) | core, atomic, mutex, errors, logging, settings, store, tmux, reconciler, launch, stop, draft, env-profiles | tasks, runs, attention, grants, providers-schemas, hooks | recipes, workspace-lease, git | scheduler, retry, budgets, waits | hosts, ssh-transport, remote-fs |
| Desktop (Playwright) | 4 scenarios in `desktop.spec.ts` | task board; run stream; artifact viewer; attention inbox | recipes UI | schedule editor | hosts panel |
| Python (unittest) | 3 tests covering filesystem + edits + preview | bundle.py | recipe artifact digest | – | remote_fs.py |
| Package (smoke) | 12-tab traversal | 6-tab task stream + inbox traversal | – | schedule firing | remote-host simulation |

**Test discipline**

- Every invariant in §0 has at least one regression test named after its identifier (e.g., `tests/recovery/i-1-reconnect.test.ts`).
- Every API method in §3 has at least one happy-path and one validation-failure test.
- Every provider adapter is **capability-tested** against the actual installed CLI in the user's environment at the time the gate passes; the version is recorded in the run record.
- New Python helpers get tests that exercise the OneDrive-mounted workspace; existing `helpers/file_listing.py` cursor pagination is reused.

---

## 6. Operational concerns

### 6.1 Logging and audit

- Continue using `Logger` from `src/main/logging.ts` (NDJSON, daily rotation, scrubber for command/content/secret/clipboard/environment).
- Add an **audit sink** for grants, task transitions, schedule firings, host connections. Same scrubber rules; rotation separate.
- Audit retention = `settings.auditRetentionDays` (default 30).
- Logs and audit are user-inspectable; default export path is `profile/exports/<timestamp>.zip` with a redaction guarantee documented in `docs/architecture.md`.

### 6.2 Settings expansion

Add groups without breaking existing keys:

```ts
{
  task: {
    pollIntervalMs: 1000…30000, default 2000;
    spawnAckTimeoutMs: 1000…30000, default 5000;
    spoolByteBudget: 1024…134217728, default 16 * 1024 * 1024;
  },
  provider: {
    codexPath: string | null,
    claudePath: string | null,
    defaultProfileId: string | null,
    capabilityCheckIntervalMs: 60000,
  },
  scheduler: {
    misfireDefault: "skip",
    overlapDefault: "skip",
    latenessWindowMs: 1000…3600000, default 60000,
    catchupLimit: 1,
  },
  remote: {
    sshKnownHostsFile: string,
    sshConnectTimeoutMs: 1000…60000, default 8000,
    agentForwardingDefault: "deny",
  },
}
```

Existing `settingsSchema.parse` continues to work because new groups are optional with defaults.

### 6.3 Telemetry and privacy

- Renderer keeps `connect-src 'none'`; any future telemetry upload uses an explicit, audited destination and is **off by default**.
- Local history is browsable and exportable; retention is a user setting, never silent.

### 6.4 Accessibility & internationalization

- Every new component reuses `aria-*` roles; existing `Modal`, `Tab`, `Row` patterns are reused.
- All user-visible strings go through a single `t()` function; P0 is English only, but the seam exists.
- Keyboard parity for every new workflow: `j/k` for inbox, `g g` / `G` for top/bottom, `/` to filter, `Enter` to open.

### 6.5 Performance budgets

Use the targets in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11. Add these for the new work:

- Task detail open: p95 < 100 ms (render from snapshot).
- Event-bus publishing latency end-to-end (persist + notify): p95 < 50 ms.
- Artifact read for files up to 2 MiB: p95 < 200 ms.
- Schedule firing latency (offset from `expectedFireAt` to dispatch admission): p95 < 500 ms.

---

## 7. Anti-patterns (do not, under any circumstance)

- **Do not** skip `LaunchCoordinator.recover()`-style idempotency for any new dispatch.
- **Do not** interpolate a command string into tmux argv or into an SSH remote command; use argv arrays and framed JSON-RPC only.
- **Do not** store secrets, plaintext environment, or large terminal transcripts in event-bus payloads or bundles.
- **Do not** implement a "general management CLI" without scope narrowing; each tool takes typed parameters and is checked against the authenticated principal.
- **Do not** add a vector DB / embedding service until a measured failure justifies it (per [`docs/research/07-context-practice.md`](docs/research/07-context-practice.md)).
- **Do not** rely on prompt instructions to convey authority. The runtime validates each tool call.
- **Do not** auto-retry anything classified `unknown-effect`.
- **Do not** enable automatic provider substitution, account pooling, or silent fallback to billable APIs.
- **Do not** auto-resume a run after a host restart without a runtime-level integrity check.
- **Do not** claim a feature is "sandboxed" without naming the mechanism and the principal it constrains.

---

## 8. Decision traceability

| ADR (master README §11) | Spec reference |
| --- | --- |
| 001 Keep Codex/Claude as native reasoning agents | §4.2 |
| 002 Retain Electron/React/TS and tmux | §2 |
| 003 Separate local runtime and per-run transport ownership | §3 P1, P2, P5 |
| 004 SQLite state plus artifacts and audit events | §3 P1, §6.1 |
| 005 Explicit run identity, dispatch intents, reconciliation | §3 P2, §7 |
| 006 Structured CLI first; rich provider APIs capability-gated | §4.2 |
| 007 One writer per checkout, separate workspaces for parallel | §3 P2/P3, §4.5, §7 |
| 008 Typed capability catalog with pinned manifests | §4.5 |
| 009 File/search-first context and explicit handoff artifacts | §4.4 |
| 010 Small local workflow state machine and scheduler | §4.5, §4.7 |
| 011 Host-local authority with SSH-based remote transport later | §4.8 |
| 012 Grants and measured environment enforcement | §4.3, §7 |
| 013 Local supervised workflow before autonomous deployment/marketplace | §3 P0–P6, scope list |

---

## 9. Verification gates (consolidated)

These gates must be reproduced on the actual repository (not only on the snapshot). Failing any one of these blocks the next phase. The `§13 refs` column names the load-bearing contracts from §13.1 / §13.2 that must be exercised by the gate's test suite.

| Phase | Gate | Evidence location | §13 refs |
| --- | --- | --- | --- |
| P0 | Snapshot reproduced; keyboard + draft survival tests pass | `tests/desktop.spec.ts`, `npm run check` | S-5 (renderer telemetry CSP audit) |
| P1 | One-writer lock; JSON → SQLite migration is lossless; migration activation survives OneDrive-mounted source; restore runs with dispatch disabled | `tests/tasks/migration.test.ts`, `tests/tasks/runtime.test.ts`, new `tests/tasks/restore.test.ts` | R-3, R-5 |
| P2 | Single-agent task loop works on a disposable test project; grants enforced; replay-safe dedupe; spool framing + ack; reviewer-binds-candidate-tree | `tests/tasks/runner.test.ts`, `tests/grants/policy.test.ts`, `tests/spool.test.ts`, `tests/desktop.spec.ts` extended scenarios | R-1, R-2, R-3, R-4, R-6, S-1, S-2, S-3 |
| P3 | Two-writer isolation; recipe pinning with manifest digest; cross-provider handoff without transcript bleed; destructive operations gated; hook recursion bounded | `tests/workspace/lease.test.ts`, `tests/recipes/runner.test.ts`, `tests/recipes/handoff.test.ts` | R-3, S-2, S-3, S-4 |
| P4 | Schedule firing across DST; retry classification; durable waits; budget honest when not enforceable | `tests/scheduler/dst.test.ts`, `tests/scheduler/retry.test.ts`, `tests/scheduler/waits.test.ts` | R-6 |
| P5 | Host identity verification; partition handling with no replacement spawn; remote cancellation ack | `tests/remote/identity.test.ts`, `tests/remote/ssh-transport.test.ts` | R-1, R-2 |
| P6 | Signed staged release; backup/export/import round-trip; accessibility audit; commercial thresholds measured against §13.3 | `scripts/sign.*.mjs`, `tests/release/export.test.ts`, manual accessibility checklist, cohort decision document | S-5, §13.3 |

---

## 10. Implementation order (recommended sequencing)

This is the order that minimizes whole-day context switches between modules. Other orders are possible; this one is optimized for incremental verifiability.

| Day | Work | Files touched | Test files touched | §13 refs |
| --- | --- | --- | --- | --- |
| 1 | P0 verification & drift doc; renderer CSP telemetry audit | none | `tests/desktop/telemetry-csp.test.ts` | S-5 |
| 2–3 | P1 lock + `better-sqlite3` spike + migration harness | `src/main/tasks/runtime.ts`, `src/main/store.ts`, `scripts/spike-sqlite.{mjs,ts}` | `tests/tasks/migration.test.ts` | R-3, R-5 |
| 4 | P1 SQLite schema + active-store locator + restore mode | `src/main/tasks/persistence.ts` | `tests/tasks/persistence.test.ts`, `tests/tasks/restore.test.ts` | R-5 |
| 5 | P2 shared schemas (tasks, runs, attention, grants, bundles) | `src/shared/*.ts` | `tests/shared-schemas/*.test.ts` | R-6 |
| 6–7 | P2 LocalRuntime + dispatch intent + spool; separately-supervised runner process | `src/main/tasks/{runtime,spool}.ts`, spawn helper | `tests/tasks/runtime.test.ts`, `tests/tasks/spool.test.ts`, `tests/tasks/runner-process.test.ts` | R-1, R-2, R-4, R-6 |
| 8 | P2 ProviderAdapter contract + Codex adapter; secret-slot dereference at execution | `src/main/providers/{adapter,codex,schema}.ts`, `src/main/grants/*` | `tests/providers/codex.test.ts`, `tests/grants/policy.test.ts` | S-1, S-2 |
| 9–10 | P2 renderer split + TaskBoard/Detail/Inbox; destructive-op grants surfaced as attention | `src/renderer/*`, `src/preload/index.ts` | `tests/desktop.spec.ts` extended | S-3 |
| 11 | P3 workspace lease (already P2 entry per R-3); capability manifest digests | `src/main/workspace/lease.ts`, manifest extensions | `tests/workspace/lease.test.ts` | R-3, S-4 |
| 12–13 | P3 recipes runner + catalog; pinned digest + promotion diff | `src/main/recipes/*`, `src/shared/recipes.ts` | `tests/recipes/runner.test.ts` | S-4 |
| 14 | P3 handoffs without transcript bleed; hook depth limits | extensions + bundles + hooks | `tests/recipes/handoff.test.ts`, `tests/hooks.test.ts` | S-2, S-3, S-4 |
| 15–16 | P4 scheduler store + triggers + runner; DST + misfire | `src/main/scheduler/*`, `src/shared/schedules.ts` | `tests/scheduler/*` | R-6 |
| 17–18 | P4 durable waits + retry classification + budgets | scheduler extensions | `tests/scheduler/retry.test.ts`, `tests/scheduler/waits.test.ts` | R-6 |
| 19–20 | P5 hosts + ssh-transport + capabilities; remote cancellation reported as unconfirmed | `src/main/remote/*` | `tests/remote/*` | R-1, R-2 |
| 21 | P6 license inventory + signing scripts | `scripts/*`, `THIRD_PARTY` | `tests/release/licenses.test.ts` | S-5 |
| 22 | P6 backup/export/import + accessibility + commercial thresholds measurement | new scripts + renderer audits + cohort decision document | `tests/release/export.test.ts`, manual checklist, cohort write-up | S-5, §13.3 |

This sequencing assumes one person and continuous attention; it is not a calendar plan.

---

## 11. What an implementing agent reads first

If time is limited, read in this order:

1. §0 invariants table.
2. §2 target module layout.
3. §3 P0–P2 only.
4. §4.1 task lifecycle (the contract is the spine for everything else).
5. §4.3 grants (the authority model is reused by recipes, scheduler, and remote).
6. §13.1 R-1 through R-6 and §13.2 S-1 through S-5 — these are the tests that must pass at each gate; they are the contract you cannot weaken.
7. The research note(s) relevant to the current task.
8. The existing `src/main/service.ts` and `src/main/workspace-state.ts` to re-confirm the patterns.

Anything beyond §4.4 should be implemented only after the user is satisfied with P0–P2 evidence.

---

## 12. Open questions the implementing agent should resolve (not guess)

These questions must be answered with a spike or test before the corresponding phase is marked done.

| Phase | Question | How to resolve |
| --- | --- | --- |
| P0 | Does the v1.1 verification record reproduce on the current source? | Run `npm run check`, `npm run test:desktop`, `npm run test:package` against isolated `MINIMAL_DATA_DIR` |
| P1 | Which SQLite binding delivers reproducible behavior on OneDrive-mounted WSL? | Spike with `better-sqlite3`, `node:sqlite`, and `node-sqlite3` |
| P2 | Which Codex CLI version is the user's installed binary? | Capture and pin |
| P3 | What is the default Git version and its `worktree add` behavior under the user account? | Spike |
| P4 | How does the user's IANA zone library handle historical DST transitions? | Spike |
| P5 | What is the user's SSH server distribution and key algorithm support? | Probe on registration |
| P6 | Which bundled-component licenses are MIT/ISC/Apache-2.0 vs commercial? | Run `license-checker --production` |

Each unresolved question must be answered with a concrete observation (output capture), not with documentation alone.

---

## 13. Reconciliation with the specialist reviews

The five specialist reviews (09 practitioner signals, 10 evaluation, 11 UX/attention, 12 commercial, 13 runtime, 14 security, 15 final review) sharpen the contracts in §3–§4. This section makes those sharpenings first-class so an implementing agent does not have to re-read every review before each phase.

### 13.1 Runtime review (13) — six load-bearing contracts

Each item below must be present in the gate evidence for the indicated phase; "should" in §3 is upgraded to "must" here.

| # | Contract | Owning phase | Required test |
| --- | --- | --- | --- |
| R-1 | A launch deduplication claim is persisted (`run.start` row carrying `dispatchId` + immutable `actionDigest`) **before** any provider process is spawned. Expired or unknown claims are refused, not silently treated as fresh. | P2 entry | Repeat a `startAttempt` call between intent commit and spawn; between spawn and ack; between ack and reconciliation. Only one provider process exists per `dispatchId`. |
| R-2 | The managed runner is a **separately supervised** local process that owns its tmux server, not a child of the Electron-main service. The runtime's service scope is declared separately and verified on cold startup. Cancellation reports `unconfirmed` when a child of the invocation cannot be observed. | P2 entry | Restart the Electron-main service while a provider invocation is running; the provider survives. Kill the runner itself; the cancellation is reported as `unconfirmed`, never silently completed. |
| R-3 | A workspace lease exists for **every** managed writer from P2 onward. The lease is keyed by `(workspaceId, runtimeGeneration)`; stale control by a previous generation is rejected. Lock identity is stable across DB relocation; a stale lock file is **never** unlinked by an automatic recovery. | P2 entry | Race two starters; only one dispatches. Reconnect an old controller after runtime replacement; the runtime refuses stale control. Interrupt the runtime while a provider still writes; no replacement writer enters the uncertain checkout. |
| R-4 | The spool uses framed records with `(invocationId, runnerIncarnation, seq)` and detects incomplete tails. Ingestion cursor, domain transition and audit event commit **together** before acknowledgement. Acknowledge only a contiguous committed prefix; duplicate `(invocationId, seq)` with different bytes is a protocol error. Byte budget is set before exhaustion; failure records are not unconditional when the disk itself fails. | P2 mid | Lose acks; reorder; truncate a tail; fill storage; fail a flush. Previously acknowledged facts remain recoverable. Output is bounded. Cancellation remains responsive under pressure. |
| R-5 | Migration activates by staging and validating on the destination filesystem, then durable replacement of a small active-store locator **on that filesystem**. `rename` across mounts is **not** assumed atomic. The legacy tmux namespace is preserved explicitly. Old clients are stopped before migration; their presence is detected, not assumed away. SQLite's `PRAGMA foreign_keys` is enabled; integrity check includes foreign-key violations. Restore runs with dispatch disabled; never silently initializes an empty profile. | P1 gate | Interrupt every migration phase; exercise failed dir-fsync, corrupt input, incompatible old-client startup, missing backup artifacts. Recovery selects one known store; never replays restored intents automatically. |
| R-6 | Idempotency, revision, and scope are ordered: authenticate → resolve scoped idempotency key + canonical digest → apply revision/admission checks. Different input under the same idempotency key is a conflict. Uniqueness covers `(principal, profile, operation, key)` and `(invocation, incarnation, event-sequence)`. `retryOfRunId` is separate from parent/child; `continuationOfInvocationId` carries the provider-supported resume reference. Inspection steps never complete a multi-step run. | P2 mid | Repeat an accepted request with stale revision; obtain the same handle without another capacity reservation. Retry with changed input; obtain `CONFLICT`. Continue a paused run; obtain a new invocation linked to that run. Complete only an inspection step in the repair recipe; the task remains unaccepted. |

### 13.2 Security review (14) — five concrete control surfaces

| # | Control | Owning phase | Required test |
| --- | --- | --- | --- |
| S-1 | Authority is a typed grant, never a prompt outcome. Tool-call `projectId` and similar parameters cannot exceed the connection's principal's accessible set. Approvals bind to the exact candidate, configuration, environment and revision. Replay of an authenticated intent returns the original outcome without a second observable side effect. | P2 | Inject task text that requests wider authority; the runtime rejects the operation. Inject a tool call with a foreign `projectId`; the runtime returns the recorded principal's set. Change a file between approval and resume; approval is invalidated. Replay each authenticated request type; exactly one observable side effect. |
| S-2 | Untrusted content is never authority. Bundles carry named secret **slots** resolved at execution time, never plaintext. Retrieved pages, issue comments and tool errors are explicitly delimited; agent output that "tries to grant itself" is rejected and surfaced in the review summary. | P2 / P3 | Place a fake secret reference inside a retrieved document; confirm no plaintext reaches the prompt and the runtime refuses to dereference undeclared references. Inject an authoritative-sounding instruction inside a fetched page; confirm grants do not change. |
| S-3 | Destructive operations (`--force`, recursive delete, branch delete, force-push, plan apply without a saved plan) are gated by explicit grants, not by prompt text. Child budgets (`maxParallelism`, `maxSubagentDepth`) are enforced by the runtime. | P2 / P3 | Inject a task whose only successful path uses `--force`; confirm the runtime surfaces a pending approval rather than executing silently. Trigger a recursive delegation chain that exceeds the budget; confirm the runtime refuses the next spawn and reports the limit. |
| S-4 | Capability manifests carry a pinned digest and a publisher/source. Active runs use the digest in effect when the run started; a digest change requires a deliberate promotion and a visible diff. MCP responses are treated as untrusted content; hook recursion is depth-limited; blocking hooks cannot re-enter the runtime as a new principal. | P3 | Install a skill, pin it in a recipe, update the skill, run the recipe against the pinned version; the active run uses the pinned digest. Update a plugin to a version with new permissions; the runtime requires re-authorization. Trigger a hook that re-enters via the runtime as a new principal; confirm refusal. |
| S-5 | Renderer telemetry respects the renderer CSP (`connect-src 'none'`); any future telemetry upload uses an explicit, audited destination and is off by default. Local history is inspectable, exportable, and subject to documented retention; retention does not delete the only pending approval or the only recoverable candidate. Error reports are scrubbed for paths, hostnames, environment variables, secret references and large artifact bodies before they leave the device; the scrubber is itself tested. | P2 / P6 | Attempt an unallowed network egress from the renderer; confirm the request is blocked and the attempt is logged. Trigger a diagnostic upload with a fake secret reference in the payload; confirm the scrubber strips it. |

### 13.3 Commercial positioning review (12) — first-paid-tier boundaries

The buyer hypothesis in `12-commercial-positioning.md` is **host-local, personal workspace, recovery-and-review**. This implies three explicit scope boundaries the master README owner-review section must call out, and which the P6 gate must verify before any paid enrollment:

1. **The first paid tier is host-local only.** P5 SSH transport is technically possible but is **not** part of the first paid offer. Any "team" or "remote" pricing is a later cohort, gated on measured paid retention of the host-local offer.
2. **Provider inference is paid separately by the user.** MINIMAL never bills provider API spend. Any "managed compute" or "hosted execution" tier is a different package with a separate go/no-go experiment; it is not implied by the first paid tier.
3. **Three experiment packages** (`Solo recovery and review`, `Owned-host routines`, `Small-team adoption`) are hypothesis-stage. The 12-week behavioral / payment / support thresholds in §"Three experiment packages" of that review are the go/no-go rules. Below threshold: narrow or stop the package; do not silently fall through to a default.

P6 gate evidence therefore includes, for each enrolled cohort, the measured paid continuation rate, the measured support load, and a written decision against the threshold before any cohort is expanded.

### 13.4 Final review (15) — three explicit corrections

The final review recommends three corrections before implementation begins. Each is reflected in this spec:

| Correction | Where reflected in this spec |
| --- | --- |
| Move workspace leases into P2 (or explicitly defer parallel managed writes). | §3 P2 entry references §13.1 R-3; the lease table is part of the P2 schema, not deferred to P3. |
| Clarify ADR 003 to name the runtime-vs-Electron-main process boundary. | §13.1 R-2 specifies that the runner is a separately supervised local process; §2 module layout marks `src/main/tasks/runtime.ts` as the runtime boundary and `service.ts` as the Electron-main facade. |
| Note in the master README's owner-review section that the first paid tier is host-local only. | §13.3 makes this boundary explicit; the P6 gate requires a written call-out in the README before any paid enrollment. |

Two P0 housekeeping items from the final review (glossary, ADR-to-evidence cross-reference) are tracked under §12 (open questions) and are not blockers.

### 13.5 UX/attention review (11) — attention model constraints

The attention inbox is the user-facing surface for everything that requires a decision or a stale-state reconciliation. Constraints that govern its design and that of any feature emitting into it:

- An `AttentionItem` is created exactly once per underlying event; re-emission increments `revision`, never creates a duplicate.
- Dismissal is **not** authorization. Dismissing a `decision` attention item records `seenAt` but not `resolvedAt`; only an explicit resolution creates the second timestamp.
- Stale state surfaces as `attention-required: stale` with the offending `revision` and the proposed corrective action; the user confirms, the runtime does not auto-correct.
- Keyboard parity for every row: `j`/`k` navigation, `g g` / `G` to top/bottom, `/` to filter, `Enter` to open, `x` to dismiss. The modal reuses the existing `Modal` and `Row` patterns from `components.tsx`.

### 13.6 Practitioner / evaluation reviews (09, 10) — measurement before retrieval infrastructure

Both reviews converge on the same rule: do not introduce a vector database, embedding service or a Temporal-style orchestration framework until a **measured** local failure justifies it. The implementation order in §10 honors this by deferring retrieval infrastructure entirely and by keeping the scheduler self-contained in `src/main/scheduler/` with no external dependency.

---

## 14. Closing note

This specification is consistent with the existing invariants in [`build-snapshot-v1.1.md`](../docs/build-snapshot-v1.1.md), with the architecture contracts in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and with the research evidence collected in [`docs/research/`](docs/research). Where this specification differs from the README's narrative form, the differences are intentional and limited to:

- Concretising the SQLite binding choice (the README defers it as a spike; this spec recommends `better-sqlite3` and explains why).
- Moving workspace leases forward from P3 to P2 entry (per [`docs/research/13-runtime-review.md`](docs/research/13-runtime-review.md) §3, now restated as R-3 in §13.1).
- Naming the runtime-vs-Electron-main process boundary explicitly (per the final review's ADR 003 sharpening, now restated as R-2 in §13.1).
- Adding a `§13 Reconciliation with the specialist reviews` section that turns every "should" from the runtime, security, UX and commercial reviews into a named, testable contract.
- Constraining the first paid tier to host-local only and binding the P6 gate to the commercial review's measured thresholds.

These changes must be reflected in a documentation PR before P1 begins.

This is a **proposed** specification. It is approved for implementation only by an explicit owner instruction. Until then, no code in the current repository should change in response to it.
