# MINIMAL 1.2.9 — M6.1 workflow-executor renderer wiring

This release closes the **renderer-side half** of the M6.1 bullet
in
[`FUTURE/IMPLEMENTATION-README.md`](../FUTURE/IMPLEMENTATION-README.md).
The non-renderer half (protocol, dispatcher, preload, executor
implementation) landed across M3c.x and M6.x. This cut ships the
first renderer file in the tree to call
`window.minimal.runWorkflow(...)`, plus an advanced-gated durable
counterpart that exercises the M6.4 durable executor.

## Headline deliverable

> Workflow executor (M6.1) — inline plan-and-run engine on top of
> the durable ledger. Reusable, batchable, recoverable. Bounded
> fan-out. Schema-validated steps. Audit-friendly.
>
> — M6.1 bullet

The renderer wiring below maps to each clause:

| M6.1 clause | Renderer-side delivery |
| --- | --- |
| Inline plan-and-run engine | `src/renderer/WorkflowRunner.tsx` calls `window.minimal.runWorkflow(...)` end-to-end and renders the typed `WorkflowResult` envelope |
| Reusable | Three built-in fixtures (hello-world, two-step chain, cycle-broken) — pickable from a `<select>`, editable in a `<textarea>` |
| Batchable | The same widget runs the graph inline against the dispatcher (no per-step UI plumbing) |
| Recoverable | Advanced-gated **Run durable** button calls `window.minimal.runWorkflowDurable(...)` which persists a `workflow_run` row |
| Bounded fan-out | `MAX_FANOUT=16` enforced by Zod at the protocol boundary; the executor clamps gracefully below it |
| Schema-validated steps | The dispatcher re-parses the response through `workflowResultSchema`; protocol-layer rejects unknown step kinds |
| Audit-friendly | The result view shows `auditDigest` per run + per-step `stepOutputs` in a `<table>` |

## What's new

### Workflow runner dialog (`Ctrl+Shift+P` → "Run inline workflow")

A new palette command (scope: `session`) opens
[`src/renderer/WorkflowRunner.tsx`](../src/renderer/WorkflowRunner.tsx)
— a `<Modal>` that lets the operator:

- Pick a built-in fixture from a `<select>` (`hello-world`,
  `command-only`, `cycle-broken`).
- Edit the workflow-graph JSON in a `<textarea>` that's
  `spellCheck={false}`, `rows={18}`, and labelled
  `"Workflow graph JSON"` for AT.
- Click **Run inline** → calls
  `window.minimal.runWorkflow({workflow, settings})` and renders
  the typed envelope.
- Click **Run durable (advanced)** → (advanced gate) calls
  `window.minimal.runWorkflowDurable({workflow, settings})` which
  persists a `workflow_run` row.

The dialog respects the same focus / `role="alert"` / `data-testid`
pattern used elsewhere in the renderer; the run buttons carry
`data-testid="workflow-run-inline"` and
`data-testid="workflow-run-durable"` so the headless DOM contract
is stable.

### Typed envelope visibility

The result region renders the same discriminated union the protocol
defines at `src/shared/protocol.ts:257-289`:

- `kind: "ok"` → a green-bordered region with the workflowId,
  the `auditDigest` (64-hex char SHA-256), and a per-step table
  (`stepId` + `JSON.stringify(output, null, 2)`).
- `kind: "conflict"` → a red-bordered region with the dispatcher's
  `reason` string (cycle gate, dependency gate, Zod issue, etc.).

The renderer mirrors the schema in plain TS (no Zod re-import) so
the type is honest at the call site — the runtime validates the
wire shape; what the renderer renders is what `parseRequest` /
`workflowResultSchema` accept.

### Advanced-gated durable entry

The **Run durable (advanced)** button stays disabled when
`localStorage("minimal.advanced") === "off"`. It carries
`aria-disabled="true"` and a tool-tip pointing the user to
**Presets → Advanced controls**. Once the gate flips on (M9.3
component), the button enables and the same renderer hands the
graph to `window.minimal.runWorkflowDurable(...)`. The runtime
returns the same `WorkflowResult` envelope (durability refers to
the `workflow_run` row + restart hooks — the renderer code path is
symmetric with inline).

### IPC seam additions

- `src/shared/protocol.ts` — registered `run-workflow-durable`
  with the same `MAX_DEADLINE_MS` (10 minutes) as
  `run-workflow`.
- `src/runtime/workspace.ts` — dispatcher delegates to
  `runWorkflowDurable(worker, input)` from
  `src/runtime/orchestration/workflow-durable.ts:196`. AppError /
  ZodError surface as `{kind: "conflict"; reason}` (mirroring the
  inline path).
- `src/preload/index.ts` — `runWorkflowDurable` exposed on
  `window.minimal`.
- `src/shared/types.ts` — `API.runWorkflowDurable(input)` typed as
  the same discriminated union as `runWorkflow`.

### Cheatsheet integration

[`src/renderer/cheatsheet-data.ts`](../src/renderer/cheatsheet-data.ts)
gains one row:

| Shortcut | Action | Scope |
| --- | --- | --- |
| `Ctrl+Shift+P` | Run inline workflow (palette) | global |

(The hotkey itself was already wired in 1.2.8; this row points the
user at the new command.)

## Test coverage

Three layers of tests cover the wiring.

### IPC dispatcher tests
[`tests/runtime/workflow-ipc.test.ts`](../tests/runtime/workflow-ipc.test.ts)
now exercises **both** `run-workflow` and `run-workflow-durable`:

- Protocol timeout is `MAX_DEADLINE_MS` for both methods.
- A completed wait-only workflow returns the structured `ok`
  envelope through `parseRequest`.
- The cycle gate returns `kind: "conflict"` with the human
  reason (cycle / dependency / edge).
- A partial settings override is accepted as-is (Zod partial).
- An out-of-range `maxFanout: 9999` is refused at the protocol
  layer.
- The durable dispatcher persists a `workflow_run` row with
  `status: "completed"` and `terminal_outcome: "completed"`.
- `parseRequest` rejects an unknown step kind for both methods.

### Headless DOM contract
[`tests/desktop/workflow-runner.spec.ts`](../tests/desktop/workflow-runner.spec.ts)
asserts the visible behaviour:

- Palette → "Run inline workflow" opens the dialog and the JSON
  editor is present.
- The **Run inline** button is the enabled primary action; the
  **Run durable** button is rendered but disabled (Advanced gate
  off by default).
- Clicking **Run inline** with the `hello-world` fixture renders a
  `kind:"ok"` result region with at least one step row.
- Clicking **Run inline** with the `cycle-broken` fixture renders
  a `kind:"conflict"` red-bordered region whose `reason` mentions
  cycle / dependency / edge.
- Setting `localStorage("minimal.advanced")` to `on` enables the
  **Run durable** button; clicking it with the `hello-world`
  fixture returns the `kind:"ok"` envelope (and persists a
  `workflow_run` row in the durable executor).

### Existing executor tests still pass

- `tests/runtime/workflow-executor.test.ts` (28 tests) — inline
  executor semantics.
- `tests/runtime/workflow-durable.test.ts` (13 tests) — durable
  executor semantics + restart hooks.
- `tests/runtime/m6-gate.test.ts` (9 tests) — M6 milestone gate.

## Honest limits of M6.1

- **No live-poll for the durable runner.** Today the renderer
  surfaces the typed `WorkflowResult` envelope synchronously
  (the durable executor is durable by virtue of the
  `workflow_run` row it writes, not by being asynchronous). A
  live-runner spinner / polling seam is a future UI improvement;
  out of scope for 1.2.9.
- **Three built-in fixtures only.** Operator-driven workflow
  authoring is a future seam. The renderer is wired such that the
  next cut can drop a recipe-publishing UI behind the same
  advanced gate without re-touching the IPC layer.
- **M6.1 fixture body coverage remains a M9.5 follow-up.** All
  six step kinds (`agent | command | check | approval | artifact
  | wait`) have unit-level coverage in the executor tests but
  this 1.2.9 release exercises the **command** and **wait** kinds
  through the renderer fixtures.

## Telemetry-off-by-default preserved

The M6.1 wiring does not change the telemetry-off-by-default
contract. `settings.telemetry: false` default is unchanged; the
22-key allowlist scrubber is unchanged; the canary pipeline still
catches planted tokens; the CSP audit
(`tests/desktop/telemetry-csp.spec.ts`) still passes.

## Supported prefix (advertised workflows)

The supported prefix of user-facing features is unchanged from
1.2.8. The M6.1 wiring exposes a new **advanced-gated** UI
surface; all five advertised workflows remain:

1. Local project + dirty import.
2. Scoped lead + provider coordination.
3. Verifiable evidence + acceptance.
4. Routine save + schedule.
5. Resume + export.

## Known follow-ups

- **Recipe-publishing UI (M6.2).** The dispatcher / preload /
  schema are in place; the cheapest next cut is a recipe editor
  that publishes into the same `runWorkflow` IPC.
- **Live durable-runner poll.** A spinner / poll that observes
  `workflow_run.status` transitions and updates the result region
  in place.
- **M6.1 fixture body coverage (M9.5 follow-up).** Add
  render-time fixtures for `agent`, `check`, `approval`, and
  `artifact` step kinds — the executor tests already cover them.
- **M9.3 screen-reader qualification rows.** The 3-row table in
  `docs/screen-reader-qualification.md` is still empty. Future
  work: run the qualification operator on three independent days
  and tick M9.3 "qualified" once all five flows pass on both
  configurations.

## Verification

```bash
# Typecheck — must include the new renderer file
npx tsc --noEmit                                                                  # 0 errors

# Build — vite handles the new .tsx via the existing entry
npm run build                                                                     # exits 0

# Existing M6.1 / M6.4 / IPC tests still pass
npx tsx --test tests/runtime/workflow-executor.test.ts \
                 tests/runtime/workflow-ipc.test.ts \
                 tests/runtime/workflow-durable.test.ts \
                 tests/runtime/m6-gate.test.ts                                    # all green

# New headless DOM contract
npx playwright test tests/desktop/workflow-runner.spec.ts                          # all green

# Prior M9 freshness guards still pass — the boundary docs are unchanged
npx tsx --test tests/release/distribution-inventory.test.ts \
                 tests/docs/security-statement.test.ts \
                 tests/docs/provider-economics.test.ts \
                 tests/docs/commercial-decision.test.ts \
                 tests/release/cancel-walkaway.test.ts                            # all green

# Prior gates (M9.0–M9.5) still pass
npx tsx --test tests/runtime/m9_5-pilot-gate.test.ts \
                 tests/runtime/m9-gate.test.ts \
                 tests/runtime/m7-gate.test.ts                                     # all green

# Renderer integration test — full Electron launch
npx playwright test tests/desktop/workflow-runner.spec.ts                          # all green

# CSP audit still locked
npx playwright test tests/desktop/telemetry-csp.spec.ts --grep "source"            # passes
```
