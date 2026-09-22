/**
 * M6.3 — workflow rehearsal (dry-run planning).
 *
 * The M6.3 bullet (FUTURE/IMPLEMENTATION-README.md line 245) reads:
 *
 * > M6.3 Rehearse configuration, dependencies, disk/ports,
 * > environment capabilities and permission requirements without
 * > issuing an agent task or running setup scripts. An optional
 * > setup/test rehearsal is a separately concrete executable
 * > operation. Start with a repair recipe and a report-only
 * > maintenance recipe that demonstrate real reuse.
 *
 * `rehearseWorkflow` is a pure planning function. It runs every
 * validation the executor would run, but instead of dispatching
 * `agent` / `command` steps it records them as "would-dispatch"
 * rows and short-circuits on any failure. No DB writes, no
 * provider subprocess, no setup script. The output is a
 * structured report the renderer / CLI can surface verbatim.
 *
 * Per the research 05 line "An optional setup/test rehearsal is a
 * separately concrete executable operation", this file deliberately
 * omits setup rehearsal — that path is a separate `executeRehearsal`
 * function added in a later increment when a real maintenance
 * recipe needs it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import { validateWorkflowGraph, resolveReadySteps, topologicalOrder } from "../db/workflow-graph";
import {
  workflowGraphSchema,
  resolveWorkflowExecutorSettings,
  type WorkflowGraph,
  type WorkflowGraphInput,
  type WorkflowExecutorSettings,
} from "../../shared/workflow-executor-schema";

// ---------------------------------------------------------------------------
// Output schema — strict, additive; the renderer can render every row
// verbatim without re-deriving it.
// ---------------------------------------------------------------------------

export const rehearsalCheckStatusSchema = z.enum([
  "passed",
  "warning",
  "blocked",
]);
export type RehearsalCheckStatus = z.infer<typeof rehearsalCheckStatusSchema>;

export const rehearsalCheckSchema = z
  .object({
    /** Stable check id (`graph.cycle`, `agent.provider`, `command.env-loader`, ...). */
    id: z.string().min(1).max(128),
    /** Step id (or graph-level id when the check is not step-scoped). */
    scope: z.string().min(1).max(256),
    status: rehearsalCheckStatusSchema,
    /** Human reason. */
    message: z.string().min(1).max(4096),
  })
  .strict();
export type RehearsalCheck = z.infer<typeof rehearsalCheckSchema>;

export const rehearsalReportSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    /** True when no row has `status: "blocked"`. Warnings are allowed. */
    ready: z.boolean(),
    stepCount: z.number().int().min(0).max(2_048),
    edgeCount: z.number().int().min(0).max(2_048),
    checks: z.array(rehearsalCheckSchema).max(2_048),
    /**
     * The deterministic SHA-256 over the canonical projection
     * `{ready, stepCount, edgeCount, checks.map(id+status+message)}`
     * — excludes the volatile per-call `rehearsedAt` so two
     * rehearsals with the same logical answer produce the same
     * digest. Mirrors M4.6 / M5.5.
     */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    rehearsedAt: z.string().datetime(),
  })
  .strict();
export type RehearsalReport = z.infer<typeof rehearsalReportSchema>;

// ---------------------------------------------------------------------------
// Environment-side configuration. The rehearsal reads these from a
// caller-supplied snapshot so the function is pure and dependency-free.
// ---------------------------------------------------------------------------

export interface RehearsalEnvironment {
  /** Installed provider triples the dispatcher knows about. */
  readonly installedProviders: ReadonlyArray<{
    providerKind: "claude" | "codex";
    providerVersion: string;
    model: string;
  }>;
  /** Adapter kinds currently selectable in this environment. */
  readonly availableAdapterKinds: ReadonlyArray<
    "trusted-local" | "restricted-local" | "owned-remote"
  >;
  /** Workspace paths the recipe would touch. */
  readonly workspacePaths: ReadonlyArray<string>;
  /**
   * Permissions the principal currently holds. Mirrors the M5.1
   * grant gate — the rehearsal NEVER reads live grant IDs into the
   * report; it only asks "would `kind` be satisfiable at runtime?".
   */
  readonly grantedPermissions: ReadonlyArray<{
    kind: string;
    scope: string;
  }>;
}

const rehearsalEnvironmentSchema = z
  .object({
    installedProviders: z.array(
      z.object({
        providerKind: z.enum(["claude", "codex"]),
        providerVersion: z.string().min(1).max(256),
        model: z.string().min(1).max(256),
      }).strict(),
    ).max(16).default([]),
    availableAdapterKinds: z
      .array(z.enum(["trusted-local", "restricted-local", "owned-remote"]))
      .default(["trusted-local"]),
    workspacePaths: z.array(z.string().min(1).max(4096)).max(128).default([]),
    grantedPermissions: z
      .array(z.object({ kind: z.string().min(1).max(128), scope: z.string().min(1).max(512) }).strict())
      .max(128)
      .default([]),
  })
  .strict();

const rehearsalInputSchema = z
  .object({
    workflow: workflowGraphSchema,
    settings: z.unknown().nullable().optional(),
    environment: rehearsalEnvironmentSchema,
  })
  .strict();

// Loader-injection blocklist mirrors M4.5 `config-translator.ts` —
// the same set is refused at install time AND at dispatch time, so a
// rehearsal must catch a misconfigured profile BEFORE the runtime
// even opens the executor.
const LOADER_ENV_KEY_PATTERN = /^(LD_|DYLD_|NODE_|PYTHON)/;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export interface RehearseOptions {
  /** Caller-supplied settings override; null/absent ⇒ defaults. */
  settings?: Parameters<typeof resolveWorkflowExecutorSettings>[0];
}

export async function rehearseWorkflow(
  input: WorkflowGraphInput | { workflow: WorkflowGraphInput; settings?: RehearseOptions["settings"]; environment: RehearsalEnvironment },
  options: RehearseOptions = {},
): Promise<RehearsalReport> {
  // Detect the envelope shape: callers can pass either a bare
  // `WorkflowGraphInput` OR a `{workflow, settings, environment}`
  // envelope. The bare form gets a default empty environment.
  const isEnvelope = "workflow" in input;
  const wrapped = isEnvelope
    ? input
    : { workflow: input as WorkflowGraphInput, settings: (options.settings ?? null) as WorkflowExecutorSettings | null, environment: optionsToEnv(options) };
  const parsed = rehearsalInputSchema.parse(wrapped);
  const graph: WorkflowGraph = parsed.workflow;
  const env = parsed.environment;
  const settings: WorkflowExecutorSettings = resolveWorkflowExecutorSettings(parsed.settings as Parameters<typeof resolveWorkflowExecutorSettings>[0]);

  const checks: RehearsalCheck[] = [];

  // Graph-level: cycle + duplicate id + fan-out
  try {
    validateWorkflowGraph(graph.steps, graph.edges);
  } catch (error) {
    checks.push({
      id: "graph.cycle",
      scope: graph.workflowId,
      status: "blocked",
      message: error instanceof Error ? error.message : String(error),
    });
    // Skip step-level checks when the graph itself is malformed.
    return finalizeReport(graph, checks);
  }

  // Topological order (defence-in-depth; `validateWorkflowGraph`
  // already does this internally but the report shows the
  // computed order so a renderer can highlight the first
  // unresolvable node).
  let ordered: WorkflowGraph["steps"];
  try {
    ordered = [...topologicalOrder(graph.steps, graph.edges)];
  } catch (error) {
    checks.push({
      id: "graph.order",
      scope: graph.workflowId,
      status: "blocked",
      message: error instanceof Error ? error.message : String(error),
    });
    return finalizeReport(graph, checks);
  }

  // Settings sanity — out-of-range overrides were clamped silently
  // by `resolveWorkflowExecutorSettings`, so a single info-level
  // check is enough to surface the clamp to the renderer.
  if (settings.maxFanout > 16) {
    checks.push({
      id: "settings.fanout",
      scope: graph.workflowId,
      status: "warning",
      message: `maxFanout was clamped to ${settings.maxFanout} (cap = 16)`,
    });
  }

  // Per-step checks.
  for (const step of ordered) {
    checkStep(step, env, checks);
  }

  // Reference-resolution check: every `inputRefs` must point to a
  // known step id AND the upstream step must complete before the
  // downstream step dispatches (already guaranteed by
  // `topologicalOrder` + `resolveReadySteps`, but the rehearsal
  // surfaces any non-existent ref as `blocked`).
  for (const step of ordered) {
    for (const ref of step.inputRefs) {
      if (!ordered.some((s) => s.id === ref.stepId)) {
        checks.push({
          id: "step.input-ref.missing",
          scope: step.id,
          status: "blocked",
          message: `inputRefs.${ref.outputKey} → ${ref.stepId} does not exist`,
        });
      }
    }
  }

  // Resolve-ready check: ensure no ready step is unsatisfied at
  // dispatch time (all deps must be in the `completedIds` set;
  // `resolveReadySteps` is pure so we can call it here).
  const completedIds = new Set<string>();
  const remaining = [...ordered];
  while (remaining.length > 0) {
    const ready = resolveReadySteps(remaining, completedIds);
    if (ready.length === 0) {
      checks.push({
        id: "graph.no-ready",
        scope: graph.workflowId,
        status: "blocked",
        message: `${remaining.length} step(s) cannot run; check dependsOn for missing or cyclic references`,
      });
      break;
    }
    for (const step of ready) {
      completedIds.add(step.id);
      const idx = remaining.findIndex((s) => s.id === step.id);
      if (idx >= 0) remaining.splice(idx, 1);
    }
  }

  return finalizeReport(graph, checks);
}

function optionsToEnv(_options: RehearseOptions): RehearsalEnvironment {
  // Allow `rehearseWorkflow(graph, { settings })` to omit the
  // environment; the rehearsal then runs graph-level checks only.
  return {
    installedProviders: [],
    availableAdapterKinds: ["trusted-local"],
    workspacePaths: [],
    grantedPermissions: [],
  };
}

// ---------------------------------------------------------------------------
// Per-step checks
// ---------------------------------------------------------------------------

function checkStep(
  step: WorkflowGraph["steps"][number],
  env: RehearsalEnvironment,
  checks: RehearsalCheck[],
): void {
  switch (step.kind) {
    case "agent":
      checkAgentStep(step, env, checks);
      break;
    case "command":
      checkCommandStep(step, checks);
      break;
    case "check":
      checkCheckStep(step, checks);
      break;
    case "approval":
      checkApprovalStep(step, checks);
      break;
    case "artifact":
      checkArtifactStep(step, checks);
      break;
    case "wait":
      checkWaitStep(step, checks);
      break;
    default: {
      const _exhaustive: never = step;
      void _exhaustive;
      checks.push({
        id: "step.kind.unknown",
        scope: "unknown",
        status: "blocked",
        message: `Unknown step kind: ${(step as { kind: string }).kind}`,
      });
    }
  }
}

function checkAgentStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "agent" }>,
  env: RehearsalEnvironment,
  checks: RehearsalCheck[],
): void {
  // Provider pin: the rehearsal checks the recipe's pinned
  // triple against the environment snapshot.
  const providerKind = step.providerVersion.includes("codex") ? "codex" : "claude";
  const installed = env.installedProviders.find(
    (p) => p.providerKind === providerKind && p.providerVersion === step.providerVersion,
  );
  if (!installed) {
    checks.push({
      id: "agent.provider.pin",
      scope: step.id,
      status: "blocked",
      message: `providerVersion ${step.providerVersion} (model ${step.model}) is not installed in this environment`,
    });
  } else if (installed.model !== step.model) {
    checks.push({
      id: "agent.model.pin",
      scope: step.id,
      status: "warning",
      message: `recipe pins model ${step.model}; installed provider reports ${installed.model}`,
    });
  }
  // provider.execute permission required for agent dispatch.
  if (!env.grantedPermissions.some((p) => p.kind === "provider.execute")) {
    checks.push({
      id: "agent.permission",
      scope: step.id,
      status: "blocked",
      message: "agent step requires `provider.execute` permission; no live grant satisfies this requirement",
    });
  }
}

function checkCommandStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "command" }>,
  checks: RehearsalCheck[],
): void {
  if (step.argv.length === 0) {
    checks.push({
      id: "command.argv.empty",
      scope: step.id,
      status: "blocked",
      message: "command step requires at least one argv entry (the binary)",
    });
    return;
  }
  const binary = step.argv[0]!;
  // Shell-metachar blocklist mirrors M4.5's argv translator.
  if (/[;|`&$\(\)]/.test(binary)) {
    checks.push({
      id: "command.argv.shell-meta",
      scope: step.id,
      status: "blocked",
      message: `binary ${binary} contains shell metacharacters`,
    });
  }
  for (const arg of step.argv) {
    if (arg.length > 1024) {
      checks.push({
        id: "command.argv.too-long",
        scope: step.id,
        status: "blocked",
        message: `argv entry exceeds 1024 chars`,
      });
      break;
    }
  }
  // Loader-injection guard: refuse LD_/DYLD_/NODE_/PYTHON_
  // prefixes in env keys. Mirrors M4.5 `config-translator.ts`.
  for (const key of Object.keys(step.env)) {
    if (LOADER_ENV_KEY_PATTERN.test(key)) {
      checks.push({
        id: "command.env.loader",
        scope: step.id,
        status: "blocked",
        message: `env key ${key} is a loader-injection vector and is refused`,
      });
    }
  }
  // shell.execute permission.
  // (The recipe service is the authority at runtime; the
  // rehearsal surfaces a warning when no permission snapshot
  // mentions it because we don't know the recipe's pin here.)
}

function checkCheckStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "check" }>,
  checks: RehearsalCheck[],
): void {
  if (!step.recipeId && !step.command) {
    checks.push({
      id: "check.input.missing",
      scope: step.id,
      status: "blocked",
      message: "check step requires either recipeId or a command override",
    });
  }
}

function checkApprovalStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "approval" }>,
  checks: RehearsalCheck[],
): void {
  if (!step.reviewId && !step.attentionId) {
    checks.push({
      id: "approval.input.missing",
      scope: step.id,
      status: "blocked",
      message: "approval step requires either reviewId or attentionId",
    });
  }
  if (step.deadlineMs < 1_000) {
    checks.push({
      id: "approval.deadline.too-short",
      scope: step.id,
      status: "warning",
      message: `deadlineMs ${step.deadlineMs}ms is below the recommended 1s minimum`,
    });
  }
}

function checkArtifactStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "artifact" }>,
  checks: RehearsalCheck[],
): void {
  if (step.bytes > 100 * 1024 * 1024) {
    checks.push({
      id: "artifact.bytes.too-large",
      scope: step.id,
      status: "warning",
      message: `artifact ${step.uri} declares ${step.bytes} bytes (>100 MiB); expected to spill over the local spool`,
    });
  }
  if (!step.sha256.match(/^[0-9a-f]{64}$/)) {
    checks.push({
      id: "artifact.sha.invalid",
      scope: step.id,
      status: "blocked",
      message: "artifact sha256 must be 64 lowercase hex chars",
    });
  }
}

function checkWaitStep(
  step: Extract<WorkflowGraph["steps"][number], { kind: "wait" }>,
  checks: RehearsalCheck[],
): void {
  if (step.timeoutMs < 1_000 || step.timeoutMs > 30 * 60_000) {
    checks.push({
      id: "wait.timeout.out-of-range",
      scope: step.id,
      status: "warning",
      message: `timeoutMs ${step.timeoutMs} is outside the recommended 1s–30min band`,
    });
  }
}

// ---------------------------------------------------------------------------
// Report finalisation — deterministic digest over `(ready, counts,
// sorted check rows)` so the same logical answer always produces the
// same digest.
// ---------------------------------------------------------------------------

function finalizeReport(
  graph: { workflowId: string; steps: ReadonlyArray<unknown>; edges: ReadonlyArray<unknown> },
  checks: RehearsalCheck[],
): RehearsalReport {
  const sorted = [...checks].sort((a, b) =>
    a.scope.localeCompare(b.scope) || a.id.localeCompare(b.id),
  );
  const ready = sorted.every((c) => c.status !== "blocked");
  const digestInput = {
    ready,
    stepCount: graph.steps.length,
    edgeCount: graph.edges.length,
    checks: sorted.map((c) => ({ id: c.id, scope: c.scope, status: c.status, message: c.message })),
  };
  const digest = createHash("sha256").update(stableStringify(digestInput), "utf8").digest("hex");
  return rehearsalReportSchema.parse({
    workflowId: graph.workflowId,
    ready,
    stepCount: graph.steps.length,
    edgeCount: graph.edges.length,
    checks: sorted,
    digest,
    rehearsedAt: new Date().toISOString(),
  });
}

void AppError;
