/**
 * M6.1 — workflow dependency graph validation + topological helpers.
 *
 * Pure graph algorithms — no DB, no async. The helpers are exported so
 * the orchestrator can call them before dispatching any step:
 *
 *   1. `validateWorkflowGraph(steps, edges)` — refuses self-loops,
 *      unknown stepIds, and cycles via the Floyd–Warshall fixpoint
 *      carried over verbatim from `runtime/orchestration/lead-admission.ts`.
 *   2. `topologicalOrder(steps, edges)` — Kahn's algorithm; throws on
 *      a residual cycle (defence-in-depth; the cycle gate already ran).
 *   3. `resolveReadySteps(remaining, completed)` — the per-tick fan-out
 *      gate; steps whose `dependsOn` are all `completed` are runnable.
 *
 * The module never touches the database; the orchestrator owns every
 * persistence side-effect.
 */
import { AppError } from "../../shared/errors";
import {
  type WorkflowEdge,
  type WorkflowStep,
  MAX_STEPS_PER_WORKFLOW,
  MAX_EDGES_PER_WORKFLOW,
} from "../../shared/workflow-executor-schema";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a workflow graph: no self-loops, all stepIds are unique
 * and reference defined items, no cycles. Throws `AppError` with
 * `code: "INVALID_REQUEST"` for every violation.
 *
 * The cycle-detection fixpoint is copied verbatim from
 * `runtime/orchestration/lead-admission.ts:388-414` (M5.2) so the two
 * admission surfaces stay in lock-step.
 */
export function validateWorkflowGraph(
  steps: ReadonlyArray<WorkflowStep>,
  edges: ReadonlyArray<WorkflowEdge>,
): void {
  if (steps.length > MAX_STEPS_PER_WORKFLOW)
    throw new AppError("INVALID_REQUEST",
      `Workflow exceeds ${MAX_STEPS_PER_WORKFLOW} steps (got ${steps.length})`);
  if (edges.length > MAX_EDGES_PER_WORKFLOW)
    throw new AppError("INVALID_REQUEST",
      `Workflow exceeds ${MAX_EDGES_PER_WORKFLOW} edges (got ${edges.length})`);

  const ids = new Set<string>();
  for (const step of steps) {
    if (ids.has(step.id))
      throw new AppError("INVALID_REQUEST", `Duplicate stepId ${step.id}`);
    ids.add(step.id);
  }

  // Self-loops on `dependsOn`.
  for (const step of steps) {
    for (const dep of step.dependsOn) {
      if (dep === step.id)
        throw new AppError("INVALID_REQUEST", `Self-dependency on stepId ${step.id}`);
      if (!ids.has(dep))
        throw new AppError("INVALID_REQUEST", `Unknown stepId ${dep} in dependency of ${step.id}`);
    }
    for (const ref of step.inputRefs) {
      if (!ids.has(ref.stepId))
        throw new AppError("INVALID_REQUEST", `Unknown stepId ${ref.stepId} in inputRefs of ${step.id}`);
    }
  }

  // Edges — same uniqueness + self-loop + step-reference rules.
  for (const edge of edges) {
    if (edge.from === edge.to)
      throw new AppError("INVALID_REQUEST", `Self-loop on edge ${edge.from} → ${edge.to}`);
    if (!ids.has(edge.from))
      throw new AppError("INVALID_REQUEST", `Edge from unknown stepId ${edge.from}`);
    if (!ids.has(edge.to))
      throw new AppError("INVALID_REQUEST", `Edge to unknown stepId ${edge.to}`);
  }

  // Cycle detection — Floyd–Warshall over a small set; ≤ 64 steps.
  const localIds = [...ids];
  const reaches = new Set<string>();
  // Seed: `dependsOn` edges (a step depends on its parent, so parent reaches child).
  for (const step of steps)
    for (const dep of step.dependsOn) reaches.add(`${dep}→${step.id}`);
  // Seed: explicit edges.
  for (const edge of edges) reaches.add(`${edge.from}→${edge.to}`);

  // Iteratively close the reachability relation until fixpoint
  // (bounded by |localIds|²).
  for (let i = 0; i < localIds.length; i++) {
    let changed = false;
    for (const a of localIds) {
      for (const b of localIds) {
        if (reaches.has(`${a}→${b}`)) {
          for (const c of localIds) {
            if (reaches.has(`${b}→${c}`) && !reaches.has(`${a}→${c}`)) {
              reaches.add(`${a}→${c}`);
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const id of localIds) {
    if (reaches.has(`${id}→${id}`))
      throw new AppError("INVALID_REQUEST", `Dependency cycle detected involving stepId ${id}`);
  }
}

// ---------------------------------------------------------------------------
// Topological order (Kahn's algorithm)
// ---------------------------------------------------------------------------

/**
 * Compute a stable topological order over `steps`. Throws on a
 * residual cycle (defence-in-depth; `validateWorkflowGraph` already
 * refused cycles).
 *
 * Stability: when multiple steps have the same in-degree, the
 * `steps` array order is preserved so re-runs produce identical
 * audit digests.
 */
export function topologicalOrder(
  steps: ReadonlyArray<WorkflowStep>,
  edges: ReadonlyArray<WorkflowEdge>,
): ReadonlyArray<WorkflowStep> {
  const ids = steps.map((s) => s.id);
  const idIndex = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) idIndex.set(ids[i], i);

  // Compute in-degree over the explicit edge set.
  const inDegree = new Map<string, number>();
  for (const id of ids) inDegree.set(id, 0);
  const adj = new Map<string, string[]>();
  for (const id of ids) adj.set(id, []);
  for (const edge of edges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    const list = adj.get(edge.from);
    if (list) list.push(edge.to);
  }

  // Stable queue: process by original index, ascending.
  const ready: number[] = [];
  for (const id of ids) {
    if ((inDegree.get(id) ?? 0) === 0) ready.push(idIndex.get(id)!);
  }
  ready.sort((a, b) => a - b);

  const order: WorkflowStep[] = [];
  while (ready.length > 0) {
    const nextIdx = ready.shift()!;
    const next = steps[nextIdx];
    if (!next) break; // Should never happen; defensive.
    order.push(next);
    const neighbors = adj.get(next.id) ?? [];
    for (const neighbor of neighbors) {
      const d = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, d);
      if (d === 0) ready.push(idIndex.get(neighbor)!);
    }
    ready.sort((a, b) => a - b);
  }

  if (order.length !== steps.length)
    throw new AppError("INVALID_REQUEST", "Residual cycle detected after validation (Kahn incomplete)");

  return order;
}

// ---------------------------------------------------------------------------
// Ready-step resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the set of runnable steps at the current tick. A step is
 * runnable when every `dependsOn` is in `completed` AND the step is
 * in `remaining`. The result preserves the topological / array order
 * of the original graph so two runs with the same input produce the
 * same audit digest.
 */
export function resolveReadySteps(
  remaining: ReadonlyArray<WorkflowStep>,
  completed: ReadonlySet<string>,
): ReadonlyArray<WorkflowStep> {
  return remaining.filter((step) => step.dependsOn.every((dep) => completed.has(dep)));
}
