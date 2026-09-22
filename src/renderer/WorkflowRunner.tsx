/**
 * M6.1 — workflow runner dialog.
 *
 * This is the first renderer file in the tree to call
 * `window.minimal.runWorkflow(...)`. It renders a `<Modal>` that:
 *
 *   1. Lets the operator pick one of three built-in fixtures
 *      (hello-world, command-only, cycle-broken).
 *   2. Edits the workflow-graph JSON in a `<textarea>`.
 *   3. Clicks **Run inline** → calls
 *      `window.minimal.runWorkflow({workflow, settings})` and
 *      renders the typed `WorkflowResult` envelope
 *      (`completed` | `failed` | `cancelled`) or the protocol-layer
 *      `{kind:"conflict"; reason}` shape.
 *
 * The **Run durable** button (Commit 2) is rendered as a disabled
 * stub with an "Enable Advanced controls" tooltip — the actual
 * `runWorkflowDurable` IPC seam lands in the next commit.
 *
 * The typed envelope mirrors `runWorkflowEnvelopeSchema` at
 * `src/shared/workflow-executor-schema.ts:386-392` and the
 * dispatcher contract at `src/runtime/workspace.ts:399-418`. No new
 * IPC channels are introduced here — the existing `run-workflow`
 * method is reused.
 */
import { useEffect, useRef, useState } from "react";
import { Modal } from "./components";
import { isAdvancedEnabled } from "./AdvancedControls";

/**
 * Minimal shape we render in the result table. Mirrors
 * `WorkflowResult` from `src/shared/workflow-executor-schema.ts`
 * — the runtime validates the wire shape; this is just what the
 * renderer can show without re-deriving Zod.
 */
interface InlineResultOk {
  kind: "ok";
  result: {
    kind: "completed" | "failed" | "cancelled";
    workflowId: string;
    stepOutputs?: Record<string, unknown>;
    auditDigest: string;
    completedAt?: string;
    failedAt?: string;
    failedStepId?: string;
    failure?: { code: string; message: string };
    cancelledAt?: string;
    cancelledStepId?: string | null;
  };
}
interface InlineResultConflict {
  kind: "conflict";
  reason: string;
}
type InlineResult = InlineResultOk | InlineResultConflict;

/**
 * Minimal shape we render in the progress strip after a durable
 * run. Mirrors `WorkflowRunSnapshot` from
 * `src/shared/workflow-executor-schema.ts` — the runtime validates
 * the wire shape; this is just what the renderer shows without
 * re-deriving Zod. `kind: "absent"` is the "no row yet" shape the
 * runtime returns when the renderer polls before the durable
 * executor has written its `workflow_run` row.
 */
interface InlineProgressPresent {
  kind: "present";
  run: {
    uuid: string;
    workflow_id: string;
    status: "running" | "completed" | "failed" | "cancelled";
    started_at: string;
    ended_at: string | null;
  };
  stepStates: ReadonlyArray<{
    step_id: string;
    kind: string;
    state: "running" | "waiting" | "completed" | "failed" | "cancelled";
    dispatched_at: string | null;
    wake_at: string | null;
    updated_at: string;
  }>;
}
interface InlineProgressAbsent {
  kind: "absent";
  workflowId: string;
}
type InlineProgress = InlineProgressPresent | InlineProgressAbsent;

const HELLO_WORLD_GRAPH = JSON.stringify(
  {
    workflowId: "hello-world",
    steps: [
      {
        id: "step-echo",
        kind: "command",
        displayName: "echo hello",
        dependsOn: [],
        inputRefs: [],
        outputKeys: ["echoOut"],
        body: {
          argv: ["/bin/echo", "hello"],
          env: {},
          cwd: null,
          stdoutByteCap: 65536,
          stderrByteCap: 65536,
        },
      },
    ],
    edges: [],
    createdBy: "minimal-workflow-runner",
  },
  null,
  2,
);

const COMMAND_ONLY_GRAPH = JSON.stringify(
  {
    workflowId: "command-only",
    steps: [
      {
        id: "step-true",
        kind: "command",
        displayName: "/bin/true",
        dependsOn: [],
        inputRefs: [],
        outputKeys: [],
        body: {
          argv: ["/bin/true"],
          env: {},
          cwd: null,
          stdoutByteCap: 65536,
          stderrByteCap: 65536,
        },
      },
      {
        id: "step-false",
        kind: "command",
        displayName: "/bin/false",
        dependsOn: ["step-true"],
        inputRefs: [],
        outputKeys: [],
        body: {
          argv: ["/bin/false"],
          env: {},
          cwd: null,
          stdoutByteCap: 65536,
          stderrByteCap: 65536,
        },
      },
    ],
    edges: [{ from: "step-true", to: "step-false" }],
    createdBy: "minimal-workflow-runner",
  },
  null,
  2,
);

// Deliberately broken — `step-b` depends on `step-a`, and `step-a`
// depends on `step-b`. The runtime's `validateWorkflowGraph` cycle
// gate refuses this and the dispatcher returns
// `{kind:"conflict"; reason}`.
const CYCLE_BROKEN_GRAPH = JSON.stringify(
  {
    workflowId: "cycle-broken",
    steps: [
      {
        id: "step-a",
        kind: "command",
        displayName: "/bin/true (a)",
        dependsOn: ["step-b"],
        inputRefs: [],
        outputKeys: [],
        body: {
          argv: ["/bin/true"],
          env: {},
          cwd: null,
          stdoutByteCap: 65536,
          stderrByteCap: 65536,
        },
      },
      {
        id: "step-b",
        kind: "command",
        displayName: "/bin/true (b)",
        dependsOn: ["step-a"],
        inputRefs: [],
        outputKeys: [],
        body: {
          argv: ["/bin/true"],
          env: {},
          cwd: null,
          stdoutByteCap: 65536,
          stderrByteCap: 65536,
        },
      },
    ],
    edges: [
      { from: "step-a", to: "step-b" },
      { from: "step-b", to: "step-a" },
    ],
    createdBy: "minimal-workflow-runner",
  },
  null,
  2,
);

interface FixtureOption {
  readonly id: "hello-world" | "command-only" | "cycle-broken";
  readonly label: string;
  readonly json: string;
}

const FIXTURES: readonly FixtureOption[] = [
  { id: "hello-world", label: "Hello world (1 command step)", json: HELLO_WORLD_GRAPH },
  { id: "command-only", label: "Two-step chain (true → false)", json: COMMAND_ONLY_GRAPH },
  { id: "cycle-broken", label: "Cycle-broken (deliberate conflict)", json: CYCLE_BROKEN_GRAPH },
];

const DEFAULT_SETTINGS = {
  maxFanout: 4,
  defaultStepTimeoutMs: 30_000,
  waitPollMs: 250,
};

export function WorkflowRunner({ close }: { close: () => void }) {
  const [fixtureId, setFixtureId] = useState<FixtureOption["id"]>("hello-world");
  const [graphJson, setGraphJson] = useState<string>(FIXTURES[0].json);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<InlineResult | null>(null);
  // M9.3 advanced-controls gate (per-window). The durable runner is
  // an advanced surface: by default the button stays disabled and
  // the tooltip points the user to the gate. When the flag is on,
  // the button enables and calls `window.minimal.runWorkflowDurable`.
  const [advanced, setAdvanced] = useState<boolean>(() => isAdvancedEnabled());
  // M6.4 — live poll state. After a successful **Run durable** the
  // renderer starts a `setInterval` and reads the typed
  // `WorkflowRunSnapshot` from `window.minimal.getWorkflowRun(...)`.
  // The interval stops when `run.status !== "running"` so the
  // progress strip freezes on the final row state (the table below
  // the strip carries the typed `WorkflowResult` outputs the
  // executor returned).
  const [pollWorkflowId, setPollWorkflowId] = useState<string | null>(null);
  const [progress, setProgress] = useState<InlineProgress | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const next = FIXTURES.find((f) => f.id === fixtureId);
    if (next) setGraphJson(next.json);
  }, [fixtureId]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === "minimal.advanced") setAdvanced(isAdvancedEnabled());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // M6.4 — live poll loop. Fires every `cadenceMs` while
  // `pollWorkflowId !== null`. The cadence is
  // `Math.max(250, DEFAULT_SETTINGS.waitPollMs)` so the renderer
  // reads at most four times a second; on each tick the IPC
  // returns the typed `WorkflowRunSnapshot`. The interval is
  // cleared on unmount and whenever the polled run finalizes
  // (`run.status !== "running"`).
  useEffect(() => {
    if (!pollWorkflowId) return;
    const cadenceMs = Math.max(250, DEFAULT_SETTINGS.waitPollMs);
    let cancelled = false;
    const tick = async () => {
      try {
        const snapshot = await window.minimal.getWorkflowRun({ workflowId: pollWorkflowId });
        if (cancelled) return;
        setProgress(snapshot as InlineProgress);
        if (snapshot.kind === "present" && snapshot.run.status !== "running") {
          setPollWorkflowId(null);
        }
      } catch {
        // Polling failures are non-recoverable for a single tick;
        // keep polling on the next tick. The next
        // `runWorkflowDurable(...)` will surface real IPC failures.
        if (cancelled) return;
      }
    };
    const interval = setInterval(() => { void tick(); }, cadenceMs);
    // First tick fires after `cadenceMs`; we don't optimistically
    // render an empty progress strip — the result envelope from
    // the original `runWorkflowDurable` call already covers the
    // "what just happened" surface.
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollWorkflowId]);

  const runInline = async () => {
    setRunning(true);
    setResult(null);
    try {
      const workflow = JSON.parse(graphJson);
      const response = await window.minimal.runWorkflow({
        workflow,
        settings: DEFAULT_SETTINGS,
      });
      // The IPC return is already discriminated on `kind`. We surface
      // it as-is — the dispatcher's envelope unwraps the typed
      // WorkflowResult under `kind: "ok"` and surfaces validation
      // failures as `kind: "conflict"`.
      if (response.kind === "ok") {
        setResult(response as InlineResultOk);
      } else {
        setResult(response as InlineResultConflict);
      }
    } catch (error) {
      setResult({
        kind: "conflict",
        reason: `Renderer parse error: ${(error as Error).message ?? String(error)}`,
      });
    } finally {
      setRunning(false);
    }
  };

  const runDurable = async () => {
    if (!advanced) return;
    setRunning(true);
    setResult(null);
    // Clear any in-flight poll from a prior run. The new poll
    // starts when the executor returns successfully and we know
    // the workflowId we should track.
    setPollWorkflowId(null);
    setProgress(null);
    try {
      const workflow = JSON.parse(graphJson);
      const response = await window.minimal.runWorkflowDurable({
        workflow,
        settings: DEFAULT_SETTINGS,
      });
      if (response.kind === "ok") {
        setResult(response as InlineResultOk);
        // Start polling for the live durable state. The
        // `useEffect` reads `pollWorkflowId` and calls
        // `window.minimal.getWorkflowRun(...)` on a fixed cadence
        // until the run finalizes.
        setPollWorkflowId(response.result.workflowId);
      } else {
        setResult(response as InlineResultConflict);
      }
    } catch (error) {
      setResult({
        kind: "conflict",
        reason: `Renderer parse error: ${(error as Error).message ?? String(error)}`,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title="Workflow runner"
      subtitle="Run an inline M6.1 workflow against the runtime dispatcher."
      close={close}
      busy={running}
    >
      <div className="workflow-runner">
        <label className="field">
          <span>Fixture</span>
          <select
            value={fixtureId}
            onChange={(event) => setFixtureId(event.target.value as FixtureOption["id"])}
            disabled={running}
            aria-label="Workflow fixture"
          >
            {FIXTURES.map((fixture) => (
              <option key={fixture.id} value={fixture.id}>
                {fixture.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Workflow graph (JSON)</span>
          <textarea
            ref={textAreaRef}
            rows={18}
            value={graphJson}
            onChange={(event) => setGraphJson(event.target.value)}
            spellCheck={false}
            disabled={running}
            aria-label="Workflow graph JSON"
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close} disabled={running}>
            Close
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void runInline()}
            disabled={running}
            data-testid="workflow-run-inline"
          >
            Run inline
          </button>
          <button
            type="button"
            className="secondary"
            disabled={running || !advanced}
            onClick={() => void runDurable()}
            title={
              advanced
                ? "Run the workflow through the M6.4 durable executor (workflow_run row + per-step persistence)."
                : "Enable Advanced controls (Presets → Advanced controls) to unlock the durable runner."
            }
            data-testid="workflow-run-durable"
            aria-disabled={running || !advanced}
          >
            Run durable (advanced)
          </button>
        </div>
        {progress ? <WorkflowProgressView progress={progress} /> : null}
        {result ? <WorkflowResultView result={result} /> : null}
      </div>
    </Modal>
  );
}

/**
 * Compact progress strip rendered above the result table after a
 * **Run durable** completes. Reads `stepStates` from the polled
 * snapshot — one row per dispatched step with the lifecycle
 * state. The strip freezes on the final row state when the run
 * finalizes (`run.status !== "running"`) and the `useEffect`
 * clears the interval.
 *
 * For the typed `WorkflowResult` outputs (audit digest, final
 * per-step output values) the user reads the `.workflow-result`
 * region below.
 */
function WorkflowProgressView({ progress }: { progress: InlineProgress }) {
  if (progress.kind === "absent") {
    return (
      <section className="workflow-progress" data-testid="workflow-progress" aria-live="polite">
        <h3>Durable progress</h3>
        <p className="muted">No durable row yet for <code>{progress.workflowId}</code>; waiting for the executor to start the run.</p>
      </section>
    );
  }
  // Index the most-recent state per step so a re-dispatch
  // upserts cleanly. The `stepStates` rows are timestamped
  // (`updated_at`); we keep the latest by string compare (ISO-8601
  // is sortable lexicographically).
  const latestByStep = new Map<string, InlineProgressPresent["stepStates"][number]>();
  for (const row of progress.stepStates) {
    const prev = latestByStep.get(row.step_id);
    if (!prev || row.updated_at > prev.updated_at) {
      latestByStep.set(row.step_id, row);
    }
  }
  const ordered = Array.from(latestByStep.values()).sort((a, b) =>
    a.step_id.localeCompare(b.step_id)
  );
  return (
    <section className="workflow-progress" data-testid="workflow-progress" aria-live="polite">
      <h3>
        <span>Durable progress</span>
        <span className="workflow-result-id">{progress.run.workflow_id}</span>
      </h3>
      <p className="workflow-result-meta">
        status <code>{progress.run.status}</code>
      </p>
      {ordered.length === 0 ? (
        <p className="muted">No step states recorded yet.</p>
      ) : (
        <ul className="workflow-progress-list">
          {ordered.map((row) => (
            <li key={row.step_id} className={`workflow-progress-item state-${row.state}`}>
              <span className={`workflow-progress-dot state-${row.state}`} aria-hidden="true" />
              <code className="workflow-progress-step">{row.step_id}</code>
              <span className="workflow-progress-state">{row.state}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkflowResultView({ result }: { result: InlineResult }) {
  if (result.kind === "conflict") {
    return (
      <section className="workflow-conflict" role="alert" data-testid="workflow-conflict">
        <h3>Conflict</h3>
        <pre>{result.reason}</pre>
      </section>
    );
  }
  const r = result.result;
  const outputs = r.stepOutputs ?? {};
  const stepIds = Object.keys(outputs);
  return (
    <section className="workflow-result" data-testid="workflow-result">
      <h3>
        <span>{r.kind}</span>
        <span className="workflow-result-id">{r.workflowId}</span>
      </h3>
      <p className="workflow-result-meta">
        audit <code>{r.auditDigest}</code>
      </p>
      {r.kind === "failed" && r.failure ? (
        <p className="workflow-result-meta">
          failed step <code>{r.failedStepId ?? "(unknown)"}</code> · {r.failure.code} — {r.failure.message}
        </p>
      ) : null}
      {r.kind === "cancelled" ? (
        <p className="workflow-result-meta">
          cancelled at <code>{r.cancelledStepId ?? "(before any step)"}</code>
        </p>
      ) : null}
      <table className="workflow-step-table" aria-label="Step outputs">
        <thead>
          <tr>
            <th scope="col">Step</th>
            <th scope="col">Output</th>
          </tr>
        </thead>
        <tbody>
          {stepIds.length === 0 ? (
            <tr>
              <td colSpan={2}>
                <span className="muted">No step outputs recorded.</span>
              </td>
            </tr>
          ) : (
            stepIds.map((id) => (
              <tr key={id}>
                <td>
                  <code>{id}</code>
                </td>
                <td>
                  <pre>{JSON.stringify(outputs[id], null, 2)}</pre>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}
