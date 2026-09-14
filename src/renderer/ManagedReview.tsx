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
 * Both buttons are wired through the typed `window.minimal` IPC seam;
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
  Eye,
  FileText,
  Folder,
  Play,
  ScrollText,
  ThumbsDown,
  ThumbsUp,
  X,
} from "lucide-react";
import type {
  ArtifactReferenceView,
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

function TaskDetail({ task, projection, focused, previewArtifactId, onPreviewArtifact, onChanged }: {
  task: TaskView | undefined;
  projection: ManagedProjection;
  focused: boolean;
  previewArtifactId: string | null;
  onPreviewArtifact: (id: string | null) => void;
  onChanged?: () => void;
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
    return { runs, invocations, intents, grants, receipts, artifacts, attention, recipes, verifications, reviews };
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
