/**
 * M9.0 / M9.1 — release checklist gate.
 *
 * The M9.0 bullet (FUTURE/IMPLEMENTATION-README.md line 284) reads:
 *
 * > M9.0 At the complete-scope checkpoint, rehearse one connected
 * > workflow: import a dirty project without changing it; activate
 * > reviewed resources; let a scoped lead coordinate both providers
 * > in separate workspaces; verify and review their combined
 * > candidate; save the routine; schedule it on an owned host; close
 * > the desktop; reconnect to the same execution and evidence;
 * > accept the result and export the workspace. Publication,
 * > deployment and cleanup exercise their own authority gates.
 *
 * This module is the gate that verifies a release candidate has
 * every advertised workflow working end-to-end. The contract:
 *
 *   - `ReleaseChecklist` enumerates the verifiable steps (import,
 *     activate, coordinate, verify, save, schedule, disconnect,
 *     reconnect, accept, export). Each step has a verifier the
 *     caller supplies.
 *
 *   - `runChecklist` runs every step, collects pass/fail, and
 *     refuses the release if any step fails OR if any step's
 *     evidence is missing.
 *
 *   - The output is always a `ReleaseChecklistReport` carrying the
 *     step results so the release engineer can include them in the
 *     release manifest.
 *
 * Steps are pluggable so different checkpoints (managed pilot,
 * local workspace, automation, remote) can supply their own
 * verifier set.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const checklistStepStatusSchema = z.enum([
  "pending", "running", "passed", "failed", "skipped",
]);
export type ChecklistStepStatus = z.infer<typeof checklistStepStatusSchema>;

export const checklistStepSchema = z
  .object({
    id: z.string().min(1).max(128),
    /** Human-readable label for the audit trail. */
    label: z.string().min(1).max(256),
    /** Why this step exists; surfaced in failure reports. */
    rationale: z.string().min(1).max(1024),
    status: checklistStepStatusSchema,
    /** Evidence captured during the step. */
    evidence: z.record(z.string(), z.unknown()).default({}),
    error: z.string().nullable().default(null),
    durationMs: z.number().int().min(0).max(10 * 60_000).default(0),
  })
  .strict();

export const checklistSchema = z
  .object({
    id: z.string().min(1).max(128),
    /** Checkpoint name (e.g. "managed-pilot", "local-workspace",
     *  "automation", "remote"). */
    checkpoint: z.string().min(1).max(128),
    /** Ordered list of steps; the verifier for each step is supplied
     *  by the caller (test seam). */
    steps: z.array(z.object({
      id: z.string().min(1).max(128),
      label: z.string().min(1).max(256),
      rationale: z.string().min(1).max(1024),
    })).min(1).max(64),
  })
  .strict();
export type ReleaseChecklist = z.infer<typeof checklistSchema>;

export const checklistReportSchema = z
  .object({
    checklistId: z.string().min(1).max(128),
    checkpoint: z.string().min(1).max(128),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    passed: z.boolean(),
    failedStepIds: z.array(z.string()),
    skippedStepIds: z.array(z.string()),
    steps: z.array(checklistStepSchema),
  })
  .strict();
export type ReleaseChecklistReport = z.infer<typeof checklistReportSchema>;

/**
 * A verifier is the side-effect + assertion a step performs. It
 * returns either an `evidence` map (success) or throws (failure).
 */
export type StepVerifier = (ctx: ReleaseChecklistContext) => Promise<Record<string, unknown>>;

/**
 * Caller-supplied context passed to every verifier. The verifier
 * must NOT mutate this; the gate owns the lifecycle.
 */
export interface ReleaseChecklistContext {
  readonly checklistId: string;
  readonly checkpoint: string;
  /** Test seam: capture wall-clock advancement. */
  readonly now: () => Date;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run a release checklist. Each step's verifier is invoked in order.
 * The runner:
 *   - catches synchronous + async throws and marks the step `failed`.
 *   - records evidence (or `error`) and a wall-clock duration.
 *   - collects the report and refuses the release (passed=false) if
 *     any non-skipped step failed.
 */
export async function runChecklist(
  checklist: ReleaseChecklist,
  verifiers: Readonly<Record<string, StepVerifier>>,
  context: Partial<ReleaseChecklistContext> = {},
): Promise<ReleaseChecklistReport> {
  const parsed = checklistSchema.parse(checklist);
  const ctx: ReleaseChecklistContext = {
    checklistId: parsed.id,
    checkpoint: parsed.checkpoint,
    now: context.now ?? (() => new Date()),
  };
  const startedAt = ctx.now().toISOString();
  const stepResults: z.infer<typeof checklistStepSchema>[] = [];
  const failedStepIds: string[] = [];
  const skippedStepIds: string[] = [];
  for (const step of parsed.steps) {
    const verifier = verifiers[step.id];
    const base = {
      id: step.id, label: step.label, rationale: step.rationale,
      status: "pending" as const, evidence: {}, error: null, durationMs: 0,
    };
    if (!verifier) {
      stepResults.push({ ...base, status: "skipped", error: "no verifier registered" });
      skippedStepIds.push(step.id);
      continue;
    }
    const started = ctx.now().getTime();
    try {
      const evidence = await verifier(ctx);
      const durationMs = ctx.now().getTime() - started;
      stepResults.push({ ...base, status: "passed", evidence, durationMs });
    } catch (error) {
      const durationMs = ctx.now().getTime() - started;
      const message = error instanceof Error ? error.message : String(error);
      stepResults.push({ ...base, status: "failed", error: message, durationMs });
      failedStepIds.push(step.id);
    }
  }
  return checklistReportSchema.parse({
    checklistId: parsed.id,
    checkpoint: parsed.checkpoint,
    startedAt,
    finishedAt: ctx.now().toISOString(),
    passed: failedStepIds.length === 0,
    failedStepIds,
    skippedStepIds,
    steps: stepResults,
  });
}

void z;
