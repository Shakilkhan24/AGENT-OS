/**
 * M3c.1 / M3c.2 — managed review shell.
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
 * M3c.2 adds two interactive sections to `TaskDetail`:
 *   • **Verifier** — lists recipes bound to the task's `projectId`,
 *     exposes an "Approve and run verifier" button per recipe, and
 *     shows the most recent `verification` row's required-check results.
 *   • **Review** — lists reviews bound to the task (and the candidate
 *     identity triple they bind to); open reviews expose Accept/Reject
 *     buttons that call the `recordReviewDecision` IPC seam.
 *
 * M3c.5 adds three more sections to `TaskDetail`:
 *   • **Prompt editor** — a `<textarea>` whose contents are
 *     optimistic-update-saved to the `meta` table under
 *     `task-prompt-draft:<taskUuid>`. The revision counter and
 *     "Saved r{N}" footer mirror `saveDraft`.
 *   • **Actions** — four buttons (`Answer`, `Continue`, `New attempt`,
 *     `Stop`) gated by the underlying state-machine legality. Each
 *     one has a single-letter keyboard shortcut (a / c / n / s) that
 *     fires when the detail pane has focus and no textbox is active.
 *   • Three-pane focus model (`list | detail | prompt`) — `Tab` /
 *     `Shift+Tab` cycles, `Enter` promotes the list → detail, `Escape`
 *     pops `prompt → detail`.
 *
 * All buttons are wired through the typed `window.minimal` IPC seam;
 * no new globals are introduced. The component still never issues IPC
 * for read-only data — that's all derived from the `managed` block on
 * the `Snapshot`.
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
  CornerDownLeft,
  Eye,
  FileText,
  Folder,
  MessageSquare,
  Play,
  RotateCcw,
  Save,
  ScrollText,
  StopCircle,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import type {
  ArtifactReferenceView,
  AttentionItemView,
  ManagedProjection,
  ManagedProjectionOrUnavailable,
  ReviewView,
  RunStreamEntry,
  RunView,
  TaskView,
  VerificationRecipeView,
  VerificationView,
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
  // M3c.5 — three-pane focus model: list / detail / prompt (the
  // prompt editor's `<textarea>` is the third tabstop).
  const [focusedPane, setFocusedPane] = useState<"list" | "detail" | "prompt">("list");
  // Imperative refs so the document-level keyboard handler can
  // dispatch to the prompt editor without prop-drilling handlers.
  const promptTextareaRef = useRef<HTMLTextAreaElement | null>(null);

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
  // M3c.4 — artifact preview drawer state. Renderer-local; no IPC.
  const [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  // Reset the preview when the selection changes so a drawer for the
  // previous task can't survive into the next one.
  useEffect(() => { setPreviewArtifactId(null); }, [selectedTaskId]);

  return (
    <div className="managed-review">
      <TaskList
        projection={projection}
        selectedTaskId={selectedTaskId}
        focused={focusedPane === "list"}
        onSelect={taskId => { setSelectedTaskId(taskId); setFocusedPane("detail"); }}
        onFocus={() => setFocusedPane("list")}
      />
      <TaskDetail
        task={task}
        projection={projection}
        focused={focusedPane === "detail"}
        previewArtifactId={previewArtifactId}
        onPreviewArtifact={setPreviewArtifactId}
        onChanged={() => void window.minimal.snapshot().catch(() => {})}
        promptFocused={focusedPane === "prompt"}
        promptTextareaRef={promptTextareaRef}
        onPromptFocus={() => setFocusedPane("prompt")}
      />
      <RunStream
        task={task}
        projection={projection}
        streamByInvocation={streamByInvocation}
      />
      {previewArtifactId ? (
        <ArtifactPreview
          artifact={projection.artifacts.find(artifact => artifact.id === previewArtifactId) ?? null}
          onClose={() => setPreviewArtifactId(null)}
        />
      ) : null}
      <ManagedKeyboardController
        task={task}
        focusedPane={focusedPane}
        promptTextareaRef={promptTextareaRef}
        onCycleFocus={(pane) => setFocusedPane(pane)}
        onChanged={() => void window.minimal.snapshot().catch(() => {})}
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

function TaskDetail({ task, projection, focused, previewArtifactId, onPreviewArtifact, onChanged, promptFocused, promptTextareaRef, onPromptFocus }: {
  task: TaskView | undefined;
  projection: ManagedProjection;
  focused: boolean;
  previewArtifactId: string | null;
  onPreviewArtifact: (id: string | null) => void;
  onChanged?: () => void;
  promptFocused: boolean;
  promptTextareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onPromptFocus: () => void;
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
    // M3c.2 — recipes are project-scoped (a project's recipes are shared
    // across every task it owns); verifications and reviews are
    // task-scoped (one row per verifier run / per acceptance cycle).
    const recipes = projection.recipes.filter(recipe => recipe.projectId === task.projectId);
    const verifications = projection.verifications.filter(verification => verification.taskId === task.id);
    const reviews = projection.reviews.filter(review => review.taskId === task.id);
    // M3c.5 — open attention items per task drive the action-legality
    // checks (`answer` / `continue` need an open `decision`).
    const openAttentionForTask = projection.openAttention.filter(
      item => item.taskId === task.id && item.state !== "dismissed" && item.state !== "resolved",
    );
    const openDecision = openAttentionForTask.find(item => item.kind === "decision") ?? null;
    return { runs, invocations, intents, grants, receipts, artifacts, attention, recipes, verifications, reviews, openAttentionForTask, openDecision };
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

          <PromptEditor
            taskId={task.id}
            promptFocused={promptFocused}
            promptTextareaRef={promptTextareaRef}
            onPromptFocus={onPromptFocus}
          />

          <ActionsSection
            task={task}
            runs={lineage?.runs ?? []}
            openDecision={lineage?.openDecision ?? null}
            onChanged={onChanged}
          />

          <VerifierSection
            recipes={lineage?.recipes ?? []}
            verifications={lineage?.verifications ?? []}
            onApprove={recipeId => void runVerifier(task.id, recipeId, onChanged)}
          />

          <ReviewSection
            reviews={lineage?.reviews ?? []}
            onDecide={(reviewId, decision) => void decideReview(reviewId, decision, onChanged)}
          />

          <DiffSection runs={lineage?.runs ?? []} />

          <ArtifactsSection
            artifacts={lineage?.artifacts ?? []}
            previewArtifactId={previewArtifactId}
            onPreview={onPreviewArtifact}
          />

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
            <ArtifactsSection
              artifacts={lineage.artifacts}
              previewArtifactId={previewArtifactId}
              onPreview={onPreviewArtifact}
            />
          ) : null}

          {lineage?.attention.length ? (
            <section className="managed-section">
              <h3>Attention history <span className="managed-column-meta">{lineage.attention.length}</span></h3>
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

/* ───────── verifier section (M3c.2) ────────────────────────────────────── */

/**
 * The verifier section lists the project's recipes and exposes the
 * "Approve and run verifier" button per recipe. It also surfaces the
 * most recent verification's status next to each recipe so the user can
 * see at a glance whether the recipe has run successfully.
 *
 * IPC contract: `window.minimal.executeVerification(taskId, recipeId |
 * null, override?)` returns either an `{kind: "ok", verificationId,
 * reviewId}` or a `{kind: "conflict", reason}`. We log conflicts
 * inline; `onChanged()` triggers a re-snapshot so the projection refreshes.
 */
function VerifierSection({ recipes, verifications, onApprove }: {
  recipes: VerificationRecipeView[];
  verifications: VerificationView[];
  onApprove: (recipeId: string) => void;
}) {
  // Index verifications by `recipeId` so we can render the most-recent
  // outcome next to each recipe. We pick the row with the greatest
  // `startedAt` timestamp; absent `startedAt` falls back to the row id.
  const recentByRecipe = useMemo(() => {
    const map = new Map<string, VerificationView>();
    for (const verification of verifications) {
      if (!verification.recipeId) continue;
      const current = map.get(verification.recipeId);
      const nextStarted = verification.startedAt ?? "";
      const currentStarted = current?.startedAt ?? "";
      if (!current || currentStarted < nextStarted) map.set(verification.recipeId, verification);
    }
    return map;
  }, [verifications]);

  const runningCount = verifications.filter(verification => verification.status === "running").length;

  return (
    <section className="managed-section" data-section="verifier">
      <h3>
        Verifier <span className="managed-column-meta">{recipes.length}</span>
        {runningCount > 0 ? (
          <span className="managed-badge managed-badge-running" aria-label={`${runningCount} running`}>
            {runningCount} running
          </span>
        ) : null}
      </h3>
      {recipes.length === 0 ? (
        <p className="managed-empty">No verification recipes configured for this project.</p>
      ) : (
        <ul className="managed-recipe-list">
          {recipes.map(recipe => {
            const recent = recentByRecipe.get(recipe.id);
            const disabled = runningCount > 0;
            const argv = JSON.parse(recipe.argvJson) as ReadonlyArray<string>;
            const tooltip = `${recipe.command} ${argv.join(" ")}`.trim();
            return (
              <li key={recipe.id} className="managed-recipe-row">
                <div className="managed-recipe-info">
                  <span className="managed-recipe-name">{recipe.name}</span>
                  <span className="managed-recipe-cmd" title={tooltip}>{recipe.command}</span>
                </div>
                <div className="managed-recipe-meta">
                  {recent ? (
                    <span className={`managed-status managed-status-${recent.status}`}>
                      <CircleDot size={10} aria-hidden /> {recent.status}
                    </span>
                  ) : (
                    <span className="managed-status managed-status-unknown">not run</span>
                  )}
                  <button
                    type="button"
                    className="managed-button managed-button-primary"
                    disabled={disabled}
                    onClick={() => onApprove(recipe.id)}
                    aria-label={`Approve and run verifier for ${recipe.name}`}
                  >
                    <Play size={12} aria-hidden /> Approve and run verifier
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ───────── review section (M3c.2) ───────────────────────────────────────── */

/**
 * The review section lists reviews bound to the selected task. Open
 * reviews expose Accept/Reject buttons; accepted/rejected/invalidated
 * reviews render a terminal badge instead.
 *
 * IPC contract: `window.minimal.recordReviewDecision(reviewId, decision,
 * principal)` returns an `{kind: "ok", reviewId, status}` or a
 * `{kind: "conflict", reason}`. We log conflicts inline.
 */
function ReviewSection({ reviews, onDecide }: {
  reviews: ReviewView[];
  onDecide: (reviewId: string, decision: "accept" | "reject") => void;
}) {
  return (
    <section className="managed-section" data-section="review">
      <h3>Review <span className="managed-column-meta">{reviews.length}</span></h3>
      {reviews.length === 0 ? (
        <p className="managed-empty">No reviews recorded for this task yet.</p>
      ) : (
        <ul className="managed-review-list">
          {reviews.map(review => {
            const evidence = JSON.parse(review.evidenceVerificationIdsJson) as ReadonlyArray<string>;
            const isOpen = review.status === "open";
            return (
              <li key={review.id} className={`managed-review-row managed-review-row-${review.status}`}>
                <div className="managed-review-info">
                  <span className={`managed-status managed-status-${review.status}`}>
                    <CircleDot size={10} aria-hidden /> {review.status}
                  </span>
                  <span className="managed-review-identity" title={`base=${review.candidateBase}\ntree=${review.candidateTree}\ndiff=${review.candidateDiff}`}>
                    {review.candidateTree ? `tree ${review.candidateTree.slice(0, 7)}` : "tree —"}
                  </span>
                  <span className="managed-review-evidence">
                    {evidence.length} {evidence.length === 1 ? "evidence" : "evidence"}
                  </span>
                  {review.decidedBy ? (
                    <span className="managed-review-by">by {review.decidedBy}</span>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="managed-review-actions">
                    <button
                      type="button"
                      className="managed-button managed-button-accept"
                      onClick={() => onDecide(review.id, "accept")}
                      aria-label={`Accept review ${review.id.slice(0, 8)}`}
                    >
                      <ThumbsUp size={12} aria-hidden /> Accept
                    </button>
                    <button
                      type="button"
                      className="managed-button managed-button-reject"
                      onClick={() => onDecide(review.id, "reject")}
                      aria-label={`Reject review ${review.id.slice(0, 8)}`}
                    >
                      <ThumbsDown size={12} aria-hidden /> Reject
                    </button>
                  </div>
                ) : (
                  <span className="managed-review-terminal">terminal</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/* ───────── diff section (M3c.4) ────────────────────────────────────────── */

/**
 * M3c.4 — candidate diff section.
 *
 * Renders the unified diff between `base` and `tree` for the most-recent
 * run with both refs set. The diff is fetched on demand via
 * `window.minimal.renderCandidateDiff(runId)`; the response is cached
 * per `runId` inside the component so re-mounts don't re-fetch.
 *
 * The body is rendered as escaped `<pre>` text. Line-type colour comes
 * from the leading character (`+` → green, `-` → red, ` ` → neutral,
 * `@@` → slate hunk header, `diff --git` / `index` / `---` / `+++` →
 * slate file header). No parsing, no eval, no HTML injection: every
 * line is plain text inside `<pre>` with `white-space: pre-wrap`.
 */
function DiffSection({ runs }: { runs: RunView[] }) {
  // Pick the most-recent run that has both refs set (those are the
  // fields `verifier-execute.ts` writes after a verifier commits).
  const candidateRunId = useMemo(() => {
    for (const run of [...runs].reverse()) {
      if (run.baseRevision && run.terminalUuid) return run.id;
    }
    return undefined;
  }, [runs]);
  const [open, setOpen] = useState(false);
  type DiffResult = Awaited<ReturnType<typeof window.minimal.renderCandidateDiff>>;
  type FetchState =
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; diff: DiffResult }
    | { kind: "error"; reason: string };
  const [state, setState] = useState<FetchState>({ kind: "idle" });
  // Per-runId cache so re-renders don't repeat the IPC.
  const cache = useRef<Map<string, DiffResult>>(new Map());
  const fetched = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !candidateRunId) return;
    const hit = cache.current.get(candidateRunId);
    if (hit) { setState({ kind: "ok", diff: hit }); fetched.current = candidateRunId; return; }
    if (fetched.current === candidateRunId) return;
    fetched.current = candidateRunId;
    setState({ kind: "loading" });
    window.minimal.renderCandidateDiff(candidateRunId)
      .then((diff) => {
        cache.current.set(candidateRunId, diff);
        setState({ kind: "ok", diff });
      })
      .catch((error: unknown) => {
        fetched.current = null;
        const reason = String(error instanceof Error ? error.message : error)
          .replace(/^Error invoking remote method '[^']+': Error: /, "");
        setState({ kind: "error", reason });
      });
  }, [open, candidateRunId]);

  if (!candidateRunId) {
    return (
      <section className="managed-section" data-section="diff">
        <h3>Candidate diff</h3>
        <p className="managed-empty">
          No managed workspace yet — run a verifier to see the diff.
        </p>
      </section>
    );
  }

  return (
    <section className="managed-section" data-section="diff">
      <h3>
        Candidate diff <span className="managed-column-meta">{candidateRunId.slice(0, 8)}</span>
        <button
          type="button"
          className="managed-button"
          aria-expanded={open}
          aria-controls={`diff-body-${candidateRunId}`}
          onClick={() => setOpen(value => !value)}
          title={open ? "Hide diff" : "Show diff"}
        >
          <FileText size={12} aria-hidden /> {open ? "Hide diff" : "Show diff"}
        </button>
      </h3>
      {open ? (
        <DiffBody state={state} />
      ) : (
        <p className="managed-empty">
          Diff collapsed. Click "Show diff" to render the unified text for
          this run's candidate.
        </p>
      )}
    </section>
  );
}

function DiffBody({ state }: {
  state:
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; diff: Awaited<ReturnType<typeof window.minimal.renderCandidateDiff>> }
    | { kind: "error"; reason: string };
}) {
  if (state.kind === "loading") {
    return <p className="managed-empty">Rendering unified diff…</p>;
  }
  if (state.kind === "error") {
    return <p className="managed-empty managed-empty-error">Diff unavailable: {state.reason}</p>;
  }
  if (state.kind === "idle") {
    return <p className="managed-empty">Diff not loaded.</p>;
  }
  const { diff } = state;
  if (diff.bytes === 0) {
    return <p className="managed-empty">No changes between base and tree.</p>;
  }
  const lines: string[] = diff.body.split("\n");
  return (
    <div className="diff-body">
      <div className="diff-meta">
        <span>base {diff.base.slice(0, 7)}</span>
        <span>tree {diff.tree.slice(0, 7)}</span>
        <span>
          {diff.truncated
            ? `${formatBytes(MAX_DIFF_BYTES_RENDER)} shown / ${formatBytes(diff.bytes)} captured`
            : `${formatBytes(diff.bytes)}`}
        </span>
      </div>
      {diff.truncated ? (
        <p className="managed-empty managed-empty-warn">
          Diff truncated at {formatBytes(MAX_DIFF_BYTES_RENDER)} — open the
          workspace to view the full diff.
        </p>
      ) : null}
      <pre className="diff-pre" id={`diff-body-${diff.runId}`}>
        {lines.map((line: string, index: number) => (
          <span key={index} className={diffLineClass(line)}>{line}{"\n"}</span>
        ))}
      </pre>
    </div>
  );
}

function diffLineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line-file-header";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "diff-line-file-header";
  if (line.startsWith("@@")) return "diff-line-hunk";
  if (line.startsWith("+")) return "diff-line-add";
  if (line.startsWith("-")) return "diff-line-del";
  return "diff-line-neutral";
}

/** Mirror of the runtime's MAX_DIFF_BYTES (256 KiB); re-exported here so the renderer
 * doesn't have to import the runtime module just to render the cap label. */
const MAX_DIFF_BYTES_RENDER = 256 * 1024;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/* ───────── artifacts section (M3c.4) ───────────────────────────────────── */

/**
 * M3c.4 — artifacts list with a "Preview" affordance per row.
 *
 * Replaces the M3c.1 inline `<ul>` so each artifact row can open the
 * `ArtifactPreview` drawer. The drawer state is owned by
 * `ManagedReviewAvailable` — this component just dispatches the id.
 */
function ArtifactsSection({ artifacts, previewArtifactId, onPreview }: {
  artifacts: ArtifactReferenceView[];
  previewArtifactId: string | null;
  onPreview: (id: string | null) => void;
}) {
  return (
    <section className="managed-section" data-section="artifacts">
      <h3>Artifacts <span className="managed-column-meta">{artifacts.length}</span></h3>
      <ul className="managed-run-list">
        {artifacts.map(artifact => {
          const active = previewArtifactId === artifact.id;
          return (
            <li key={artifact.id} className="managed-artifact-row">
              <span className="managed-status managed-status-imported">
                <CircleDot size={10} aria-hidden />
              </span>
              <span className="managed-run-id">{artifact.kind}</span>
              <span className="managed-run-status">{artifact.mime || "—"}</span>
              <span className="managed-run-invocations">
                {artifact.bytes} bytes · {artifact.uri}
              </span>
              <button
                type="button"
                className={`managed-button managed-button-preview ${active ? "active" : ""}`}
                aria-pressed={active}
                aria-label={`Preview artifact ${artifact.kind}`}
                onClick={() => onPreview(active ? null : artifact.id)}
              >
                <Eye size={12} aria-hidden /> {active ? "Close preview" : "Preview"}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ───────── artifact preview drawer (M3c.4) ─────────────────────────────── */

/**
 * M3c.4 — bounded artifact preview drawer.
 *
 * Mounted as an absolutely-positioned right-side panel anchored inside
 * the `managed-review` shell. Calls `previewArtifact(id, "user", null)`
 * (the M3c.3 IPC seam) and renders the bounded base64 body as escaped
 * text inside `<pre>`. `AppError` surfaces as an inline notice.
 *
 * Closing: Escape, the × button, or clicking the backdrop. No new IPC.
 */
function ArtifactPreview({ artifact, onClose }: {
  artifact: ArtifactReferenceView | null;
  onClose: () => void;
}) {
  type PreviewResult = Awaited<ReturnType<typeof window.minimal.previewArtifact>>;
  type PreviewState =
    | { kind: "loading" }
    | { kind: "ok"; preview: PreviewResult }
    | { kind: "error"; reason: string };
  const [state, setState] = useState<PreviewState>({ kind: "loading" });

  useEffect(() => {
    if (!artifact) return;
    setState({ kind: "loading" });
    window.minimal.previewArtifact(artifact.id, "user", null)
      .then((preview) => setState({ kind: "ok", preview }))
      .catch((error: unknown) => {
        const reason = String(error instanceof Error ? error.message : error)
          .replace(/^Error invoking remote method '[^']+': Error: /, "");
        setState({ kind: "error", reason });
      });
  }, [artifact?.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!artifact) {
    return null;
  }
  const mime = artifact.mime || "";
  const isTextual = mime.startsWith("text/") || mime === "application/json"
    || mime === "application/x-sh" || mime === "application/xml"
    || mime === "image/svg+xml" || mime === "";
  const showBody = state.kind === "ok" && isTextual
    && !state.preview.truncated
    && state.preview.truncatedBase64Content.length > 0;

  return (
    <aside
      className="artifact-preview-drawer"
      role="dialog"
      aria-label={`Artifact preview: ${artifact.kind}`}
    >
      <header className="artifact-preview-header">
        <span className="artifact-preview-title">
          <Eye size={13} aria-hidden />
          <strong>{artifact.kind}</strong>
          <span className="managed-column-meta">{artifact.mime || "—"}</span>
        </span>
        <button
          type="button"
          className="icon-button"
          aria-label="Close preview"
          onClick={onClose}
        >
          <X size={14} aria-hidden />
        </button>
      </header>
      <div className="artifact-preview-body">
        {state.kind === "loading" ? (
          <p className="managed-empty">Fetching preview…</p>
        ) : state.kind === "error" ? (
          <p className="managed-empty managed-empty-error">
            Preview unavailable: {state.reason}
          </p>
        ) : !isTextual ? (
          <p className="managed-empty">
            Binary artifact ({state.preview.mime}) — preview not available.
            Open the workspace to view the full file.
          </p>
        ) : state.preview.truncated ? (
          <p className="managed-empty managed-empty-warn">
            Truncated at 8 KiB — open the workspace to view the full artifact.
          </p>
        ) : !showBody ? (
          <p className="managed-empty">No body returned.</p>
        ) : (
          <pre className="artifact-preview-pre">
            {decodePreviewBody(state.preview.truncatedBase64Content)}
          </pre>
        )}
      </div>
      {state.kind === "ok" ? (
        <footer className="artifact-preview-footer">
          <div>
            <span className="managed-column-meta">sha256</span>
            <code>{state.preview.sha256.slice(0, 12)}…</code>
          </div>
          <div>
            <span className="managed-column-meta">uri</span>
            <code title={artifact.uri}>{artifact.uri}</code>
          </div>
          <div>
            <span className="managed-column-meta">bytes</span>
            <code>{state.preview.bytes.toLocaleString()}</code>
          </div>
        </footer>
      ) : null}
    </aside>
  );
}

function decodePreviewBody(base64: string): string {
  try {
    const binary = atob(base64);
    // Decode byte-by-byte to UTF-8 so non-ASCII bytes stay legible.
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "(preview body is not valid UTF-8)";
  }
}

/* ───────── prompt editor (M3c.5) ───────────────────────────────────────── */

/**
 * M3c.5 — task-prompt drafts.
 *
 * Persists the prompt text into the `meta` table under
 * `task-prompt-draft:<taskUuid>`. Same optimistic-update shape as
 * `saveDraft`: the renderer tracks the live revision, the runtime
 * refuses mismatches with `CONFLICT`, the editor rolls forward on
 * success.
 *
 * Saves debounce 400ms after the last keystroke. The "Saved r{N}"
 * footer shows the freshly assigned revision. The textarea itself
 * is the third focus target in the three-pane focus model.
 */
const PROMPT_DRAFT_BASE_HASH = "0".repeat(64);
const PROMPT_DRAFT_DEBOUNCE_MS = 400;

function PromptEditor({ taskId, promptFocused, promptTextareaRef, onPromptFocus }: {
  taskId: string;
  promptFocused: boolean;
  promptTextareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onPromptFocus: () => void;
}) {
  type Draft = { content: string; baseHash: string; updatedAt: string; revision: number };
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftText, setDraftText] = useState<string>("");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const liveRevisionRef = useRef<number>(0);

  // Load on mount / when the task id changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    window.minimal.readTaskPromptDraft(taskId)
      .then((loaded) => {
        if (cancelled) return;
        if (loaded) {
          setDraft(loaded);
          setDraftText(loaded.content);
          liveRevisionRef.current = loaded.revision;
          setSavedAt(loaded.updatedAt);
        } else {
          setDraft(null);
          setDraftText("");
          liveRevisionRef.current = 0;
          setSavedAt(null);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(`Failed to load draft: ${String(reason)}`);
      });
    return () => { cancelled = true; };
  }, [taskId]);

  // Imperatively focus the textarea when `promptFocused` becomes true.
  useEffect(() => {
    if (promptFocused) promptTextareaRef.current?.focus();
  }, [promptFocused, promptTextareaRef]);

  // Debounced save: fires 400ms after the last keystroke.
  useEffect(() => {
    const expected = liveRevisionRef.current;
    if (draft !== null && draftText === draft.content) return;
    const timer = setTimeout(() => {
      const expectedAtSave = expected;
      window.minimal.saveTaskPromptDraft(taskId, {
        content: draftText,
        baseHash: PROMPT_DRAFT_BASE_HASH,
        expectedRevision: expectedAtSave,
      }).then((saved) => {
        liveRevisionRef.current = saved.revision;
        setDraft(saved);
        setSavedAt(saved.updatedAt);
        setError(null);
      }).catch((reason: unknown) => {
        const message = String(reason instanceof Error ? reason.message : reason);
        if (/CONFLICT|expected r/i.test(message)) {
          // Another writer beat us; reload the canonical draft and
          // surface the conflict so the user can reconcile.
          window.minimal.readTaskPromptDraft(taskId)
            .then((loaded) => {
              if (loaded) {
                liveRevisionRef.current = loaded.revision;
                setDraft(loaded);
                setDraftText(loaded.content);
                setSavedAt(loaded.updatedAt);
              }
              setError(`Draft conflict: another writer updated it; loaded latest r${liveRevisionRef.current}.`);
            })
            .catch(() => {});
        } else {
          setError(`Save failed: ${message}`);
        }
      });
    }, PROMPT_DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftText, draft, taskId]);

  return (
    <section className="managed-section managed-prompt-editor" data-section="prompt-editor">
      <h3>
        Prompt editor
        {draft ? (
          <span className="managed-column-meta">r{draft.revision}</span>
        ) : (
          <span className="managed-column-meta">draft</span>
        )}
      </h3>
      <textarea
        ref={promptTextareaRef}
        className="managed-prompt-textarea"
        value={draftText}
        rows={6}
        spellCheck
        aria-label="Task prompt draft"
        data-prompt-editor="true"
        placeholder="Draft the prompt that will be sent to the provider on the next attempt…"
        onFocus={onPromptFocus}
        onChange={event => setDraftText(event.target.value)}
      />
      <div className="managed-prompt-footer">
        {savedAt ? (
          <span>Saved r{draft?.revision ?? 0} at {formatTimestamp(savedAt)}</span>
        ) : (
          <span>Not yet saved</span>
        )}
        <span className="managed-column-meta">{draftText.length} chars</span>
      </div>
      {error ? <p className="managed-empty managed-empty-error">{error}</p> : null}
    </section>
  );
}

/* ───────── actions section (M3c.5) ─────────────────────────────────────── */

/**
 * M3c.5 — four managed-work actions: `Answer`, `Continue`, `New attempt`,
 * `Stop`. Each button is disabled when its preconditions aren't met
 * (e.g. `Continue` requires an open `decision` attention item, `Stop`
 * is illegal on a terminal run).
 *
 * Conflicts surface inline; `onChanged()` triggers a re-snapshot so
 * the projection refreshes.
 */
function ActionsSection({ task, runs, openDecision, onChanged }: {
  task: TaskView;
  runs: RunView[];
  openDecision: AttentionItemView | null;
  onChanged?: () => void;
}) {
  // Latest run drives Stop / New attempt legality.
  const latestRun = runs.length > 0 ? runs[runs.length - 1] : null;
  const isRunTerminal = latestRun
    ? latestRun.status === "cancelled" || latestRun.status === "completed" || latestRun.status === "failed"
    : true;
  const canStop = latestRun !== null && !isRunTerminal;
  const canNewAttempt = latestRun !== null && !isRunTerminal;
  const canAnswer = openDecision !== null;
  const canContinue = openDecision !== null;

  // Inline reply input state.
  const [replyText, setReplyText] = useState("");
  const [showReplyInput, setShowReplyInput] = useState(false);

  return (
    <section className="managed-section managed-actions" data-section="actions">
      <h3>
        Actions
        <span className="managed-column-meta" title="Keyboard: a / c / n / s with detail focused">a c n s</span>
      </h3>
      <div className="managed-action-row">
        <button
          type="button"
          className="managed-button managed-button-answer"
          disabled={!canAnswer}
          onClick={() => {
            if (canAnswer) setShowReplyInput(value => !value);
          }}
          aria-label="Answer the open decision"
        >
          <MessageSquare size={12} aria-hidden /> Answer (a)
        </button>
        <button
          type="button"
          className="managed-button managed-button-continue"
          disabled={!canContinue}
          onClick={() => {
            if (canContinue && openDecision) {
              void runContinueInvocation(task, openDecision.id, onChanged);
            }
          }}
          aria-label="Continue the open decision by spawning a continuation invocation"
        >
          <CornerDownLeft size={12} aria-hidden /> Continue (c)
        </button>
        <button
          type="button"
          className="managed-button managed-button-new-attempt"
          disabled={!canNewAttempt}
          onClick={() => {
            if (canNewAttempt && latestRun) {
              void runNewAttempt(task, latestRun.id, onChanged);
            }
          }}
          aria-label="Spawn a fresh invocation for the latest run"
        >
          <RotateCcw size={12} aria-hidden /> New attempt (n)
        </button>
        <button
          type="button"
          className="managed-button managed-button-stop"
          disabled={!canStop}
          onClick={() => {
            if (canStop && latestRun) {
              void runStop(task, latestRun.id, onChanged);
            }
          }}
          aria-label="Stop the latest run"
        >
          <StopCircle size={12} aria-hidden /> Stop (s)
        </button>
      </div>
      {showReplyInput && openDecision ? (
        <div className="managed-action-row">
          <input
            type="text"
            className="managed-action-input"
            value={replyText}
            placeholder="Reply to the decision…"
            onChange={event => setReplyText(event.target.value)}
            onKeyDown={event => {
              if (event.key === "Enter" && replyText.trim().length > 0) {
                void runAnswer(openDecision.id, replyText, () => {
                  setReplyText("");
                  setShowReplyInput(false);
                  onChanged?.();
                });
              } else if (event.key === "Escape") {
                setShowReplyInput(false);
              }
            }}
          />
          <button
            type="button"
            className="managed-button managed-button-primary"
            disabled={replyText.trim().length === 0}
            onClick={() => {
              if (replyText.trim().length === 0) return;
              void runAnswer(openDecision.id, replyText, () => {
                setReplyText("");
                setShowReplyInput(false);
                onChanged?.();
              });
            }}
          >
            <Save size={12} aria-hidden /> Submit
          </button>
        </div>
      ) : null}
    </section>
  );
}

/* ───────── keyboard controller (M3c.5) ─────────────────────────────────── */

/**
 * M3c.5 — document-level keyboard handler.
 *
 * `Tab` / `Shift+Tab` cycles the three-pane focus model
 * (list → detail → prompt → list). `Enter` only promotes list → detail
 * (the contract promised at the file header). The four letter keys
 * (`a` / `c` / `n` / `s`) dispatch the corresponding Action when the
 * detail pane is focused AND `document.activeElement` is not an
 * `<input>` / `<textarea>` (so typing in the prompt editor doesn't
 * hijack the action hotkeys). `Escape` pops prompt → detail when no
 * preview drawer is open.
 *
 * Legality mirrors `ActionsSection`: an illegal action no-ops even
 * when the key is pressed.
 */
function ManagedKeyboardController({ task, focusedPane, promptTextareaRef, onCycleFocus, onChanged }: {
  task: TaskView | undefined;
  focusedPane: "list" | "detail" | "prompt";
  promptTextareaRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  onCycleFocus: (pane: "list" | "detail" | "prompt") => void;
  onChanged?: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const activeIsTextbox = target instanceof HTMLElement
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      // Tab cycling — always allowed unless inside a textbox.
      if (event.key === "Tab" && !event.shiftKey) {
        if (activeIsTextbox) return;
        event.preventDefault();
        const order: Array<"list" | "detail" | "prompt"> = ["list", "detail", "prompt"];
        const idx = order.indexOf(focusedPane);
        const next = order[(idx + 1) % order.length] ?? "list";
        onCycleFocus(next);
        if (next === "prompt") promptTextareaRef.current?.focus();
        return;
      }
      if (event.key === "Tab" && event.shiftKey) {
        if (activeIsTextbox) return;
        event.preventDefault();
        const order: Array<"list" | "detail" | "prompt"> = ["prompt", "detail", "list"];
        const idx = order.indexOf(focusedPane);
        const next = order[(idx + 1) % order.length] ?? "detail";
        onCycleFocus(next);
        return;
      }
      // Escape pops prompt → detail.
      if (event.key === "Escape" && focusedPane === "prompt" && !activeIsTextbox) {
        event.preventDefault();
        onCycleFocus("detail");
        return;
      }
      // Letter-key hotkeys require detail-pane focus + no textbox.
      if (focusedPane !== "detail") return;
      if (activeIsTextbox) return;
      if (!task) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Cheap legality probe via the projection: skip the openDecision
      // check by reading straight off the snapshot is too heavy; we
      // defer to the button click handler which already enforces
      // legality. The hotkey only fires when the user has explicit
      // detail focus; the click handler will silently no-op on an
      // illegal action.
      if (event.key === "a") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".managed-button-answer")?.click();
        return;
      }
      if (event.key === "c") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".managed-button-continue")?.click();
        return;
      }
      if (event.key === "n") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".managed-button-new-attempt")?.click();
        return;
      }
      if (event.key === "s") {
        event.preventDefault();
        document.querySelector<HTMLButtonElement>(".managed-button-stop")?.click();
        return;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [task, focusedPane, promptTextareaRef, onCycleFocus, onChanged]);
  return null;
}

/* ───────── IPC shims (M3c.2) ───────────────────────────────────────────── */

async function runVerifier(taskId: string, recipeId: string, onChanged?: () => void): Promise<void> {
  try {
    const result = await window.minimal.executeVerification(taskId, recipeId, null);
    if (result.kind === "conflict") {
      // Surface as a console warning so devtools catches it; the next
      // projection refresh will reflect whatever state the executor left.
      console.warn("execute-verification conflict:", result.reason);
    }
    onChanged?.();
  } catch (error) {
    console.error("execute-verification failed:", error);
    onChanged?.();
  }
}

async function decideReview(reviewId: string, decision: "accept" | "reject", onChanged?: () => void): Promise<void> {
  try {
    const result = await window.minimal.recordReviewDecision(reviewId, decision, "user");
    if (result.kind === "conflict") {
      console.warn("record-review-decision conflict:", result.reason);
    }
    onChanged?.();
  } catch (error) {
    console.error("record-review-decision failed:", error);
    onChanged?.();
  }
}

/* ───────── IPC shims (M3c.5) ───────────────────────────────────────────── */

async function runAnswer(attentionId: string, reply: string, onChanged?: () => void): Promise<void> {
  try {
    await window.minimal.answerAttention(attentionId, { reply, answeredBy: "user" });
    onChanged?.();
  } catch (error) {
    console.error("answer-attention failed:", error);
    onChanged?.();
  }
}

async function runContinueInvocation(task: TaskView, attentionId: string, onChanged?: () => void): Promise<void> {
  // Carry the task's recorded provider/model forward; supply an
  // empty args/scope; the runtime derives the deadline from
  // MAX_DEADLINE_MS.
  try {
    const result = await window.minimal.continueInvocation(attentionId, {
      providerVersion: task.providerVersion ?? "v1",
      model: task.model ?? "default",
      accountMode: task.accountMode ?? "authenticated",
      args: {},
      scope: {},
      deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      attemptedBy: "user",
    });
    if (result.kind === "conflict") {
      console.warn("continue-invocation conflict:", result.reason);
    }
    onChanged?.();
  } catch (error) {
    console.error("continue-invocation failed:", error);
    onChanged?.();
  }
}

async function runNewAttempt(task: TaskView, runId: string, onChanged?: () => void): Promise<void> {
  try {
    const now = Date.now();
    const result = await window.minimal.newAttempt({
      runId,
      idempotencyKey: `new-attempt:${runId}:${now}`,
      canonicalDigest: "0".repeat(64),
      providerVersion: task.providerVersion ?? "v1",
      model: task.model ?? "default",
      accountMode: task.accountMode ?? "authenticated",
      method: "agent-run",
      args: {},
      scope: {},
      deadlineAt: new Date(now + 10 * 60_000).toISOString(),
      requestedBy: "user",
    });
    if (result.kind === "conflict") {
      console.warn("new-attempt conflict:", result.reason);
    }
    onChanged?.();
  } catch (error) {
    console.error("new-attempt failed:", error);
    onChanged?.();
  }
}

async function runStop(task: TaskView, runId: string, onChanged?: () => void): Promise<void> {
  try {
    await window.minimal.requestStop(runId, {
      reason: `User-requested stop from ${task.id.slice(0, 8)}`,
      requestedBy: "user",
    });
    onChanged?.();
  } catch (error) {
    console.error("request-stop failed:", error);
    onChanged?.();
  }
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
