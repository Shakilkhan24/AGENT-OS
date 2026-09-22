# MINIMAL 1.2.10 — live durable-runner poll (M6.4 UI seam)

This release closes the first follow-up listed in
[`docs/release-notes-1.2.9.md`](release-notes-1.2.9.md):

> **Live durable-runner poll.** A spinner / poll that observes
> `workflow_run.status` transitions and updates the result region
> in place.

The M6.4 durable executor already wrote `workflow_run` +
per-step rows as it executed. What was missing was a renderer
seam that read those rows on a cadence so the user sees progress
instead of staring at a frozen dialog until the executor
returned. This cut ships that seam.

## Headline deliverable

A new read-side IPC method `get-workflow-run` plus a
`useEffect`-driven `setInterval` in
[`src/renderer/WorkflowRunner.tsx`](../src/renderer/WorkflowRunner.tsx)
that polls `workflow_run` + per-step rows on a fixed cadence
after a successful **Run durable**. The renderer renders a
`.workflow-progress` strip above the existing result table with
one row per dispatched step + a coloured dot per lifecycle
state (`running | waiting | completed | failed | cancelled`).

| M6.4 clause | Renderer-side delivery |
| --- | --- |
| Persist step outputs | `get-workflow-run` returns the live `workflow_run` row + per-step outputs |
| Durable waits | The strip's per-step state column includes `waiting` |
| Pending decisions | Approval steps surface as `waiting` rows until they resolve |
| Cancellation | Cancellation intent stays out of scope; the executor's `requestWorkflowCancellation` is a future IPC cut |
| Release execution capacity only when quiescent | `runWorkflowDurable` still serializes through the executor; the poll seam is read-only |

## What's new

### `get-workflow-run` IPC method

`src/shared/protocol.ts` registers a new read-side method that
takes a single `{workflowId: string}` and returns a typed
`WorkflowRunSnapshot`:

```ts
// src/shared/workflow-executor-schema.ts
export const workflowRunSnapshotSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("absent"), workflowId: z.string().min(1).max(128) }).strict(),
  z.object({
    kind: z.literal("present"),
    run: workflowRunRowWireSchema,
    stepOutputs: z.array(workflowStepOutputRowWireSchema).max(64),
    stepStates: z.array(workflowStepStateRowWireSchema).max(64),
  }).strict(),
]);
```

The runtime side (`src/runtime/workspace.ts`) registers the
handler alongside `run-workflow` and `run-workflow-durable`,
delegating to the existing
`loadWorkflowRunSnapshot(worker, workflowId)` helper in
`src/runtime/db/workflow-runs.ts`. No envelope — this is a
read, so `AppError` / `ZodError` surface as a real IPC
`failure` (matches `view-session-memory` style). 5 s timeout.

### Polling renderer

`src/renderer/WorkflowRunner.tsx` adds:

- `pollWorkflowId: string | null` — set to the workflowId after a
  successful **Run durable** completes.
- `progress: InlineProgress | null` — the latest
  `WorkflowRunSnapshot` from `window.minimal.getWorkflowRun(...)`.
- A `useEffect` keyed on `pollWorkflowId` that starts a
  `setInterval(cadenceMs)` and stops when
  `snapshot.kind === "present" && snapshot.run.status !== "running"`.
  The cadence is `Math.max(250, DEFAULT_SETTINGS.waitPollMs)` so
  the renderer reads at most four times a second.
- A `<WorkflowProgressView>` component that renders a single
  `.workflow-progress` section with one `<li>` per dispatched
  step + a coloured dot per state.

The `.workflow-progress` styles live in
`src/renderer/style.css`. Each state has its own dot colour:

| State | Dot colour |
| --- | --- |
| `running` | amber |
| `waiting` | blue |
| `completed` | green |
| `failed` | red |
| `cancelled` | grey |

### IPC envelope pattern notes

`get-workflow-run` deliberately returns a typed row directly
without a `{kind:"ok"; result} | {kind:"conflict"; reason}`
envelope. Rationale:

- Reads should fail with a real IPC `failure`, not a structured
  conflict envelope (matches `get-settings`, `view-session-memory`,
  `read-draft`).
- A renderer that polls on a cadence wants a typed answer per
  tick: `kind:"absent"` (no row yet) or `kind:"present"` (the
  full state). The enum is the contract.

The `WorkflowRunner` dialog tolerates IPC failures silently:
the next tick retries. The first poll after dispatch frequently
returns `kind:"absent"` (the executor's `startWorkflowRun(...)`
runs at the moment of dispatch, before the dispatcher returns).

## Test coverage

### IPC dispatcher tests

[`tests/runtime/workflow-ipc.test.ts`](../tests/runtime/workflow-ipc.test.ts)
extends `dispatcherFor(worker)` to also register
`get-workflow-run`, mirroring the runtime handler's
read-and-return-snapshot shape. Four new tests:

- **Protocol timeout is 5 000 ms** — matches `view-session-memory`.
- **`absent` snapshot returned for an unknown workflowId** —
  covers the first-tick shape.
- **`present` snapshot returned after a durable run writes a
  `workflow_run` row** — covers the steady-state shape; the
  row's status reflects the terminal outcome because the wait
  step has no durable timeout (it completes inline).
- **`parseRequest` rejects an empty workflowId** — the
  `z.string().min(1).max(128)` boundary check fires at the
  protocol layer.

### Headless DOM contract

[`tests/desktop/workflow-runner.spec.ts`](../tests/desktop/workflow-runner.spec.ts)
adds one new test: with the Advanced gate on, **Run durable**
on the `command-only` fixture renders both a `kind:"ok"` result
region and the new `.workflow-progress` strip listing both
step IDs (`step-true`, `step-false`). The strip freezes on
`state:"completed"` for both rows within the assertion window
because the executor converges in well under a second for a
small graph.

### Existing executor tests still pass

- `tests/runtime/workflow-executor.test.ts` (28 tests).
- `tests/runtime/workflow-durable.test.ts` (13 tests).
- `tests/runtime/m6-gate.test.ts` (9 tests).

## Honest limits of the poll seam

- **Polling cadence is hard-coded.** The renderer uses
  `Math.max(250, DEFAULT_SETTINGS.waitPollMs)` ms. A future
  M-cut may want a settings knob; today the executor's default
  (`waitPollMs: 250`) keeps the poll responsive without
  configuration.
- **No event-driven progress.** The polling seam refreshes at
  most four times a second. A `workspace-changed` signal fan-out
  for `workflow.started` / `workflow.step.completed` /
  `workflow.completed` could enable sub-second latency; that is
  a separate UI seam.
- **Polling failure is silent.** If `getWorkflowRun(...)` throws
  on a tick (e.g. runtime restart mid-poll), the renderer keeps
  polling until `pollWorkflowId` resets. The next
  `runWorkflowDurable(...)` will surface real IPC failures via
  the standard `Failure` envelope.
- **`cancelWorkflow` IPC seam still missing.** The runtime
  helper `requestWorkflowCancellation(worker, args)` exists at
  `src/runtime/db/workflow-runs.ts:362` but is not exposed as
  IPC. A follow-up cut can register a `request-workflow-cancellation`
  method that delegates to it.

## Telemetry-off-by-default preserved

The new IPC method does not change the telemetry-off-by-default
contract. `settings.telemetry: false` default is unchanged; the
22-key allowlist scrubber is unchanged; the canary pipeline still
catches planted tokens; the CSP audit
(`tests/desktop/telemetry-csp.spec.ts`) still passes.

## Supported prefix (advertised workflows)

The supported prefix of user-facing features is unchanged from
1.2.9. The poll seam is a UX improvement to an already-shipped
advanced-gated surface (durable workflow execution); all five
advertised workflows remain:

1. Local project + dirty import.
2. Scoped lead + provider coordination.
3. Verifiable evidence + acceptance.
4. Routine save + schedule.
5. Resume + export.

## Known follow-ups

- **`cancelWorkflow` IPC seam.** Expose
  `request-workflow-cancellation` on the dispatcher + preload +
  API. The runtime helper already exists.
- **Event-driven progress.** Add `workspace-changed` signal
  fan-out for workflow events so the strip can update within
  the IPC round-trip rather than waiting up to 250 ms.
- **Cadence settings knob.** Promote the renderer poll cadence
  to a setting (or an `advanced.durableRunner.pollMs` field).
- **M6.1 fixture body coverage (M9.5 follow-up).** Add
  render-time fixtures for `agent`, `check`, `approval`, and
  `artifact` step kinds.
- **M9.3 screen-reader qualification rows.** The 3-row table in
  `docs/screen-reader-qualification.md` is still empty.

## Verification

```bash
# Typecheck — must include the new renderer poll code
npx tsc --noEmit                                                                   # 0 errors

# Build — vite handles the new renderer code via the existing entry
npm run build                                                                      # exits 0

# M6.1 / M6.4 / IPC tests still pass (now 64 tests: 50 prior + 4 new + 10 prior IPC)
npx tsx --test tests/runtime/workflow-executor.test.ts \
                 tests/runtime/workflow-ipc.test.ts \
                 tests/runtime/workflow-durable.test.ts \
                 tests/runtime/m6-gate.test.ts                                      # all green

# M9.6 freshness tests still pass — no boundary doc changed
npx tsx --test tests/release/distribution-inventory.test.ts \
                 tests/docs/security-statement.test.ts \
                 tests/docs/provider-economics.test.ts \
                 tests/docs/commercial-decision.test.ts \
                 tests/release/cancel-walkaway.test.ts                              # all green

# Prior gates (M9 / M7) still pass
npx tsx --test tests/runtime/m9_5-pilot-gate.test.ts \
                 tests/runtime/m9-gate.test.ts \
                 tests/runtime/m7-gate.test.ts                                     # all green

# Headless DOM contract — includes the new poll strip test
npx playwright test tests/desktop/workflow-runner.spec.ts                           # all green

# CSP audit still locked
npx playwright test tests/desktop/telemetry-csp.spec.ts --grep "source"             # passes
```
