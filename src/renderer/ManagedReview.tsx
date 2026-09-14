/**
 * M3c.1 — read-only "managed" review shell.
 *
 * Three-column layout rendered when the user toggles `managedMode` in the
 * topbar:
 *
 *   ┌──────────────┬──────────────────┬──────────────────┐
 *   │  task list   │  task detail     │  run stream      │
 *   │  (project    │  (runs, invocs,  │  (escaped JSON,  │
 *   │   groups)    │   intents, ...)  │   filtered by    │
 *   │              │                  │   invocation)    │
 *   └──────────────┴──────────────────┴──────────────────┘
 *
 * Strictly read-only. The component never issues an IPC call; it only
 * consumes the `managed` block on the `Snapshot`. M3c.2 will add an
 * "Approve and run verifier" button to the detail pane; nothing here
 * prepares for it.
 *
 * Conventions:
 *  - No new CSS variables; reuses the ones declared in `style.css`.
 *  - Renders an inline empty-state notice when `snapshot.managed` is
 *    unavailable so the existing M2 surface stays the single source of
 *    truth for un-managed sessions.
 *  - Keyboard nav: ↑/↓ move selection in the task list; Enter focuses
 *    the detail pane. Backspace is intentionally a no-op (deletion is
 *    M3c.2).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertOctagon,
  CircleDot,
  Cog,
  ClipboardList,
  Folder,
  ScrollText,
} from "lucide-react";
import type {
  ManagedProjection,
  ManagedProjectionOrUnavailable,
  RunStreamEntry,
  TaskView,
} from "../shared/managed-view";
import { colourForStreamType, type RunStreamType } from "../runtime/managed-stream-types";
import "./ManagedReview.module.css";

/** Per-runtime state lives here so the shell can stay stateless. */
interface ManagedReviewProps {
  managed: ManagedProjectionOrUnavailable | undefined;
}

export function ManagedReview({ managed }: ManagedReviewProps) {
  // `available === false` → fall through to a small inline notice so the
  // user knows the surface is intentional, not a render glitch.
  if (!managed || managed.available === false) {
    return (
      <div className="managed-review unavailable">
        <ClipboardList size={28} aria-hidden />
        <span className="eyebrow">MANAGED WORK</span>
        <h2>Review shell unavailable on this profile.</h2>
        <p>
          The runtime hasn't surfaced a managed projection yet — the M3 DB
          may not be open, the schema may still be migrating, or the
          profile may be running with the M2-only driver. Continue using
          the terminal sidebar; once M3a data is recorded, this panel
          becomes available automatically.
        </p>
        {managed?.available === false ? (
          <p className="reason">
            <AlertOctagon size={13} aria-hidden />
            Reason: <code>{managed.reason}</code>
          </p>
        ) : null}
      </div>
    );
  }
  return <ManagedReviewAvailable projection={managed} />;
}

function ManagedReviewAvailable({ projection }: { projection: ManagedProjection }) {
  // The first task in alphabetical project order is the default selection;
  // the picker focuses the detail pane when the user moves the cursor.
  const firstTask = useMemo(() => {
    for (const group of projection.projectGroups) {
      if (group.tasks[0]) return group.tasks[0];
    }
    return undefined;
  }, [projection.projectGroups]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | undefined>(firstTask?.id);
  const [focusedPane, setFocusedPane] = useState<"list" | "detail">("list");

  useEffect(() => {
    // Reset selection when the projection changes shape (e.g. a task
    // disappears because it was reaped). Falls back to the new first task.
    if (!selectedTaskId) return;
    const exists = projection.projectGroups.some(group =>
      group.tasks.some(task => task.id === selectedTaskId));
    if (!exists) setSelectedTaskId(firstTask?.id);
  }, [projection, selectedTaskId, firstTask]);

  const task = projection.projectGroups
    .flatMap(group => group.tasks)
    .find(candidate => candidate.id === selectedTaskId);
  // Run stream entries grouped by invocation id so the right pane can
  // render "for invocation X" headers.
  const streamByInvocation = useMemo(() => groupByInvocation(projection.stream), [projection.stream]);

  return (
    <div className="managed-review">
      <TaskList
        projection={projection}
        selectedTaskId={selectedTaskId}
        focused={focusedPane === "list"}
        onSelect={taskId => { setSelectedTaskId(taskId); setFocusedPane("detail"); }}
        onFocus={() => setFocusedPane("list")}
      />
      <TaskDetail task={task} projection={projection} focused={focusedPane === "detail"} />
      <RunStream
        task={task}
        projection={projection}
        streamByInvocation={streamByInvocation}
      />
    </div>
  );
}

/* ───────── task list (left column) ─────────────────────────────────────── */

function TaskList({ projection, selectedTaskId, focused, onSelect, onFocus }: {
  projection: ManagedProjection;
  selectedTaskId?: string;
  focused: boolean;
  onSelect(taskId: string): void;
  onFocus(): void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const allTaskIds = useMemo(() =>
    projection.projectGroups.flatMap(group => group.tasks.map(task => task.id)),
  [projection.projectGroups]);

  useEffect(() => {
    // Keep the focused row visible in the scroll viewport.
    const active = listRef.current?.querySelector<HTMLElement>(`[data-selected="true"]`);
    active?.scrollIntoView({ block: "nearest" });
  }, [selectedTaskId]);

  return (
    <section
      className={`managed-list ${focused ? "focused" : ""}`}
      aria-label="Tasks"
      onFocus={onFocus}
      tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const currentIndex = selectedTaskId ? allTaskIds.indexOf(selectedTaskId) : -1;
        const nextIndex = (currentIndex + direction + allTaskIds.length) % allTaskIds.length;
        const nextId = allTaskIds[nextIndex];
        if (nextId) onSelect(nextId);
      }}
    >
      <header className="managed-column-header">
        <span><ClipboardList size={13} aria-hidden /> TASKS</span>
        <span className="managed-column-meta">{projection.projectGroups.reduce((sum, group) => sum + group.tasks.length, 0)}</span>
      </header>
      {projection.projectGroups.length === 0 ? (
        <p className="managed-empty">No managed tasks recorded yet.</p>
      ) : (
        <ul ref={listRef} role="listbox" aria-label="Managed tasks">
          {projection.projectGroups.map(group => (
            <li key={group.projectId} className="managed-project-group">
              <h3 className="managed-project-heading">
                <Folder size={11} aria-hidden />
                <span>{group.projectId}</span>
                <span className="managed-column-meta">{group.tasks.length}</span>
              </h3>
              <ul>
                {group.tasks.map(task => (
                  <li key={task.id}>
                    <button
                      type="button"
                      className="managed-task-row"
                      data-selected={task.id === selectedTaskId}
                      onClick={() => onSelect(task.id)}
                    >
                      <span className={`managed-status managed-status-${task.status}`}>
                        <CircleDot size={10} aria-hidden />
                      </span>
                      <span className="managed-task-title">{task.title}</span>
                      <span className="managed-task-status">{task.status}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/* ───────── task detail (centre column) ─────────────────────────────────── */

function TaskDetail({ task, projection, focused }: {
  task: TaskView | undefined;
  projection: ManagedProjection;
  focused: boolean;
}) {
  // Derived lineage for the selected task — runs, invocations, intents,
  // leases, grants, context receipts, artifacts, closed attention items.
  // We never call IPC; this is all derived from the snapshot projection.
  const lineage = useMemo(() => {
    if (!task) return undefined;
    const runs = projection.runs.filter(run => run.taskId === task.id);
    const runIds = new Set(runs.map(run => run.id));
    const invocations = projection.invocations.filter(inv => runIds.has(inv.runId));
    const intents = projection.dispatchIntents.filter(intent => runIds.has(intent.runId));
    const workspaces = projection.leases
      .filter(lease => lease.workspaceId !== "")
      .map(lease => lease.workspaceId);
    void workspaces;
    const grants = projection.grants.filter(grant => grant.taskId === task.id);
    const receipts = projection.contextReceipts.filter(receipt =>
      runIds.has(receipt.runId));
    const artifacts = projection.artifacts.filter(artifact => artifact.taskId === task.id);
    const attention = projection.closedAttention.filter(item => item.taskId === task.id);
    return { runs, invocations, intents, grants, receipts, artifacts, attention };
  }, [task, projection]);

  return (
    <section
      className={`managed-detail ${focused ? "focused" : ""}`}
      aria-label="Task detail"
      tabIndex={-1}
    >
      <header className="managed-column-header">
        <span><Cog size={13} aria-hidden /> DETAIL</span>
        {task ? <span className="managed-column-meta">{task.status}</span> : null}
      </header>
      {!task ? (
        <p className="managed-empty">Select a task to inspect its runs and persisted stream.</p>
      ) : (
        <div className="managed-detail-body">
          <h2 className="managed-task-heading">{task.title}</h2>
          <p className="managed-task-objective">{task.objective || "(no objective recorded)"}</p>
          <dl className="managed-task-meta">
            <div><dt>Project</dt><dd>{task.projectId}</dd></div>
            <div><dt>Host</dt><dd>{task.hostId}</dd></div>
            <div><dt>Model</dt><dd>{task.model || "—"}</dd></div>
            <div><dt>Provider</dt><dd>{task.providerVersion || "—"}</dd></div>
            <div><dt>Created</dt><dd>{formatTimestamp(task.createdAt)}</dd></div>
            <div><dt>Updated</dt><dd>{formatTimestamp(task.updatedAt)}</dd></div>
          </dl>

          {lineage?.runs.length ? (
            <section className="managed-section">
              <h3>Runs <span className="managed-column-meta">{lineage.runs.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.runs.map(run => (
                  <li key={run.id}>
                    <span className={`managed-status managed-status-${run.status}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{run.id.slice(0, 8)}</span>
                    <span className="managed-run-status">{run.status}</span>
                    <span className="managed-run-invocations">
                      {run.invocationCount} {run.invocationCount === 1 ? "invocation" : "invocations"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.invocations.length ? (
            <section className="managed-section">
              <h3>Invocations <span className="managed-column-meta">{lineage.invocations.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.invocations.map(invocation => (
                  <li key={invocation.id}>
                    <span className={`managed-status managed-status-${invocation.status}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{invocation.id.slice(0, 8)}</span>
                    <span className="managed-run-status">{invocation.status}</span>
                    <span className="managed-run-invocations">attempt {invocation.attempt}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.intents.length ? (
            <section className="managed-section">
              <h3>Dispatch intents <span className="managed-column-meta">{lineage.intents.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.intents.map(intent => (
                  <li key={intent.id}>
                    <span className={`managed-status managed-status-${intent.state}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{intent.method}</span>
                    <span className="managed-run-status">{intent.state}</span>
                    <span className="managed-run-invocations">
                      deadline {formatTimestamp(intent.deadlineAt)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.grants.length ? (
            <section className="managed-section">
              <h3>Authority grants <span className="managed-column-meta">{lineage.grants.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.grants.map(grant => (
                  <li key={grant.id}>
                    <span className={`managed-status managed-status-${grant.state}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{grant.kind}</span>
                    <span className="managed-run-status">{grant.state}</span>
                    <span className="managed-run-invocations">by {grant.decidedBy || "—"}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.receipts.length ? (
            <section className="managed-section">
              <h3>Context receipts <span className="managed-column-meta">{lineage.receipts.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.receipts.map(receipt => (
                  <li key={receipt.id}>
                    <span className={`managed-status managed-status-${receipt.status}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{receipt.id.slice(0, 8)}</span>
                    <span className="managed-run-status">{receipt.status}</span>
                    <span className="managed-run-invocations">{receipt.objective || "(no objective)"}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.artifacts.length ? (
            <section className="managed-section">
              <h3>Artifacts <span className="managed-column-meta">{lineage.artifacts.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.artifacts.map(artifact => (
                  <li key={artifact.id}>
                    <span className="managed-status managed-status-imported">
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{artifact.kind}</span>
                    <span className="managed-run-status">{artifact.mime || "—"}</span>
                    <span className="managed-run-invocations">
                      {artifact.bytes} bytes · {artifact.uri}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {lineage?.attention.length ? (
            <section className="managed-section">
              <h3>Closed attention <span className="managed-column-meta">{lineage.attention.length}</span></h3>
              <ul className="managed-run-list">
                {lineage.attention.map(item => (
                  <li key={item.id}>
                    <span className={`managed-status managed-status-${item.state}`}>
                      <CircleDot size={10} aria-hidden />
                    </span>
                    <span className="managed-run-id">{item.kind}</span>
                    <span className="managed-run-status">{item.state}</span>
                    <span className="managed-run-invocations">{item.issueIdentity}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}
    </section>
  );
}

/* ───────── run stream (right column) ───────────────────────────────────── */

function RunStream({ task, projection, streamByInvocation }: {
  task: TaskView | undefined;
  projection: ManagedProjection;
  streamByInvocation: Map<string | null, RunStreamEntry[]>;
}) {
  // The right pane is scoped to the selected task's invocations.
  const filtered = useMemo(() => {
    if (!task) return [];
    const runs = projection.runs.filter(run => run.taskId === task.id);
    const runIds = new Set(runs.map(run => run.id));
    const invocationIds = new Set(
      projection.invocations
        .filter(invocation => runIds.has(invocation.runId))
        .map(invocation => invocation.id));
    const collected: RunStreamEntry[] = [];
    for (const [invocationId, entries] of streamByInvocation) {
      if (invocationId != null && !invocationIds.has(invocationId)) continue;
      collected.push(...entries);
    }
    return collected.sort((left, right) => left.seq - right.seq);
  }, [task, projection, streamByInvocation]);

  return (
    <section className="managed-stream" aria-label="Run stream">
      <header className="managed-column-header">
        <span><ScrollText size={13} aria-hidden /> RUN STREAM</span>
        <span className="managed-column-meta">{filtered.length}</span>
      </header>
      {filtered.length === 0 ? (
        <p className="managed-empty">
          {task
            ? "No persisted run-stream entries yet for this task."
            : "Select a task to view its structured run stream."}
        </p>
      ) : (
        <ol className="managed-stream-list">
          {filtered.map(entry => (
            <li key={entry.seq} className="managed-stream-entry">
              <span className={`managed-stream-dot managed-stream-dot-${colourForStreamType(entry.type as RunStreamType)}`} aria-hidden />
              <span className="managed-stream-meta">
                <span className="managed-stream-seq">#{entry.seq}</span>
                <span className="managed-stream-type">{entry.type}</span>
                <span className="managed-stream-at">{formatTimestamp(entry.at)}</span>
              </span>
              <pre className="managed-stream-payload">{entry.payloadJson}</pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* ───────── helpers ─────────────────────────────────────────────────────── */

function groupByInvocation(stream: RunStreamEntry[]): Map<string | null, RunStreamEntry[]> {
  const grouped = new Map<string | null, RunStreamEntry[]>();
  for (const entry of stream) {
    const key = entry.invocationId ?? null;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }
  for (const list of grouped.values()) list.sort((left, right) => left.seq - right.seq);
  return grouped;
}

function formatTimestamp(value: string): string {
  // The wire shape is already an ISO timestamp; render the local
  // yyyy-mm-dd HH:MM:SS so the user can scan the column quickly.
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} `
    + `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}:${pad(parsed.getSeconds())}`;
}
