/**
 * M4.6.d — handoffs.
 *
 * A handoff is the structured envelope a future renderer hands to a
 * *different* run (potentially across providers) so the next execution
 * can resume work without re-deriving trust. The roadmap line is
 * exact: "Handoffs contain objective, verified state, artifacts,
 * remaining decisions/resources and next action. Cross-provider
 * transfer is a new scoped brief; hidden native state and full
 * transcripts are not translated by default."
 *
 * M4.6 enforces the "do not translate" rule by construction: the
 * `excludes` field is a *literal* `{nativeState: true, transcripts:
 * true}` record on every handoff. A future renderer cannot omit it
 * accidentally; the type system + the schema refuse a value of any
 * other shape.
 *
 * `nextAction` is derived deterministically from the run's status:
 *  - `cancelled` ⇒ `"stop"` (never auto-resume a cancelled run).
 *  - `running` / `queued` / `admitted` ⇒ `"continue"`.
 *  - `completed` / `failed` with open `decision` items ⇒ `"handoff"`.
 *  - `completed` / `failed` with no open decisions ⇒ `"new-attempt"`.
 *
 * The handoff's `crossProvider` flag is *informational* — the
 * renderer decides whether to actually invoke the cross-provider
 * flow. The audit-digest covers the bounded payload (excluding the
 * digest itself) so a reader can prove "the bytes I am reading are
 * exactly the bytes that were generated".
 *
 * Cap constants protect the renderer from accidentally requesting an
 * unbounded slice; a caller-supplied cap above the max is clamped
 * silently.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";
import { readActiveReceiptForRun } from "./context-receipts";
import { listAttention } from "./attention-items";
import { listArtifacts } from "./artifact-references";

/** Caps — values a caller may pass are clamped to these. */
export const HANDOFF_MAX_ARTIFACTS = 64;
export const HANDOFF_MAX_INVOCATIONS = 64;
export const HANDOFF_MAX_DECISIONS = 64;
export const HANDOFF_MAX_RESOURCES = 64;

export type HandoffNextAction = "continue" | "new-attempt" | "stop" | "handoff";

export type HandoffTargetProvider = "claude" | "codex";
export type HandoffTargetAccountMode = "anonymous" | "authenticated" | "trusted-host";

export interface HandoffArtifact {
  readonly id: string;
  readonly sha256: string;
  readonly kind: "input" | "context" | "evidence" | "output";
  readonly uri: string;
  readonly mime: string;
  readonly bytes: number;
}

export interface HandoffDecision {
  readonly attentionId: string;
  readonly prompt: string;
  readonly raisedAt: string;
  readonly openedBy: string;
}

export interface HandoffResource {
  readonly artifactId: string;
  readonly reason: string;
}

export interface VerifiedState {
  readonly passed: number;
  readonly failed: number;
  readonly uncertain: number;
  readonly skipped: number;
}

/**
 * Locked literal — the M4.6 gate that "hidden native state and full
 * transcripts are not translated by default". The schema accepts ONLY
 * this shape; a handoff without `nativeState: true` or `transcripts:
 * true` in `excludes` is rejected at construction.
 */
export const handoffExcludesSchema = z
  .object({
    nativeState: z.literal(true),
    transcripts: z.literal(true),
  })
  .strict();

export interface HandoffExcludes {
  readonly nativeState: true;
  readonly transcripts: true;
}

export const handoffArtifactSchema = z
  .object({
    id: z.string().uuid(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    kind: z.enum(["input", "context", "evidence", "output"]),
    uri: z.string().min(1).max(2048),
    mime: z.string().min(1).max(256),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

export const handoffDecisionSchema = z
  .object({
    attentionId: z.string().uuid(),
    prompt: z.string().min(1).max(2048),
    raisedAt: z.string().datetime(),
    openedBy: z.string().min(1).max(256),
  })
  .strict();

export const handoffResourceSchema = z
  .object({
    artifactId: z.string().uuid(),
    reason: z.string().min(1).max(512),
  })
  .strict();

export const handoffSchema = z
  .object({
    runId: z.string().uuid(),
    capturedAt: z.string().datetime(),
    sourceRevision: z.string().nullable(),
    targetRevision: z.string().nullable(),
    crossProvider: z.boolean(),
    objective: z.string().max(8000),
    verifiedState: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        uncertain: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      })
      .strict(),
    artifacts: z.array(handoffArtifactSchema).max(HANDOFF_MAX_ARTIFACTS),
    remainingDecisions: z.array(handoffDecisionSchema).max(HANDOFF_MAX_DECISIONS),
    remainingResources: z.array(handoffResourceSchema).max(HANDOFF_MAX_RESOURCES),
    nextAction: z.enum(["continue", "new-attempt", "stop", "handoff"]),
    excludes: handoffExcludesSchema,
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type Handoff = z.infer<typeof handoffSchema>;

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

const buildInputSchema = z
  .object({
    runId: z.string().uuid(),
    targetProvider: z.enum(["claude", "codex"]).optional(),
    targetModel: z.string().min(1).max(256).optional(),
    targetAccountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).optional(),
    maxArtifacts: z.number().int().nonnegative().optional(),
    maxInvocations: z.number().int().nonnegative().optional(),
    maxAttentionItems: z.number().int().nonnegative().optional(),
    crossProvider: z.boolean().optional(),
  })
  .strict();

interface ClampOpts { value: number | undefined; max: number; name: string; min?: number }
function clampCap({ value, max, name, min }: ClampOpts): number {
  if (value === undefined) return max;
  if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new AppError("INVALID_REQUEST", `Handoff cap "${name}" must be a non-negative integer (got ${value})`);
  }
  if (min !== undefined && value < min) return min;
  return Math.min(value, max);
}

/**
 * Build a handoff for a run. Pulls:
 *  - the active context receipt for `objective` + source/target revisions,
 *  - the receipt's `acceptanceChecksJson` for `verifiedState`,
 *  - the run's artifacts (by run_id),
 *  - open `decision` attention items for `remainingDecisions`,
 *  - non-expired artifacts for `remainingResources`.
 *
 * Errors: `NOT_FOUND` for an unknown `runId`, `INVALID_REQUEST` for
 * a negative cap, `CONFLICT` (via zod) for malformed inputs.
 */
export async function buildHandoff(
  worker: DbWorker,
  input: z.input<typeof buildInputSchema>,
): Promise<Handoff> {
  const parsed = buildInputSchema.parse(input);
  const cap = {
    maxArtifacts: clampCap({ value: parsed.maxArtifacts, max: HANDOFF_MAX_ARTIFACTS, name: "maxArtifacts" }),
    maxInvocations: clampCap({ value: parsed.maxInvocations, max: HANDOFF_MAX_INVOCATIONS, name: "maxInvocations" }),
    maxAttentionItems: clampCap({ value: parsed.maxAttentionItems, max: HANDOFF_MAX_DECISIONS, name: "maxAttentionItems" }),
  };
  const driver = driverOf(worker);
  const runRow = driver.prepare(`SELECT * FROM run WHERE uuid = ?`).first(parsed.runId);
  if (!runRow) throw new AppError("NOT_FOUND", `Run ${parsed.runId} not found`);

  const runStatus = String((runRow as Record<string, unknown>).status ?? "queued");
  const runTaskId = String((runRow as Record<string, unknown>).task_id ?? "");
  const baseRevision = (runRow as Record<string, unknown>).base_revision == null ? null : String((runRow as Record<string, unknown>).base_revision);

  const receipt = await readActiveReceiptForRun(worker, parsed.runId);
  const objective = receipt?.objective ?? "";
  let sourceRevision: string | null = null;
  let targetRevision: string | null = null;
  let verifiedState: VerifiedState = { passed: 0, failed: 0, uncertain: 0, skipped: 0 };
  if (receipt) {
    try {
      const selectedRevisions = JSON.parse(receipt.selectedRevisionsJson) as Record<string, unknown>;
      if (typeof selectedRevisions.sourceRevision === "string") sourceRevision = selectedRevisions.sourceRevision;
      if (typeof selectedRevisions.targetRevision === "string") targetRevision = selectedRevisions.targetRevision;
    } catch {
      // Malformed selectedRevisions — leave as null.
    }
    try {
      const checks = JSON.parse(receipt.acceptanceChecksJson) as { verifiedState?: Partial<VerifiedState> };
      if (checks && checks.verifiedState && typeof checks.verifiedState === "object") {
        const v = checks.verifiedState;
        verifiedState = {
          passed: typeof v.passed === "number" ? v.passed : 0,
          failed: typeof v.failed === "number" ? v.failed : 0,
          uncertain: typeof v.uncertain === "number" ? v.uncertain : 0,
          skipped: typeof v.skipped === "number" ? v.skipped : 0,
        };
      }
    } catch {
      // Malformed — leave zeroed.
    }
  }
  // The head revision comes from the run row (post any revision-update;
  // see `revision-update.ts` for the audit trail). sourceRevision is
  // the receipt's recorded source revision; targetRevision is the
  // configured target revision.
  if (targetRevision === null) targetRevision = baseRevision;

  // Artifacts and resources — slice by cap, slice by run_id.
  const allArtifacts = await listArtifacts(worker);
  const runArtifacts = allArtifacts.filter((a) => a.runId === parsed.runId);
  const now = new Date();
  const nonExpired = runArtifacts.filter((a) => a.expiresAt === null || new Date(a.expiresAt).getTime() > now.getTime());
  const artifactSlice: HandoffArtifact[] = runArtifacts.slice(0, cap.maxArtifacts).map((a) => ({
    id: a.id,
    sha256: a.sha256,
    kind: a.kind,
    uri: a.uri,
    mime: a.mime,
    bytes: a.bytes,
  }));

  // Open `decision` attention items scoped to the task.
  const attention = await listAttention(worker, { taskId: runTaskId });
  const openDecisions = attention.filter((item) => item.kind === "decision" && item.state !== "resolved");
  const decisionSlice: HandoffDecision[] = openDecisions.slice(0, cap.maxAttentionItems).map((item) => ({
    attentionId: item.id,
    prompt: extractPrompt(item.payloadJson),
    raisedAt: item.createdAt,
    openedBy: extractOpenedBy(item.payloadJson),
  }));

  // Resources — artifacts the next run should know about, with the
  // reason attached for human-readable explanation.
  const resourceSlice: HandoffResource[] = nonExpired.slice(0, HANDOFF_MAX_RESOURCES).map((a) => ({
    artifactId: a.id,
    reason: a.expiresAt === null
      ? `unexpired artifact (kind=${a.kind})`
      : `unexpired artifact (kind=${a.kind}, expiresAt=${a.expiresAt})`,
  }));

  // nextAction is computed deterministically from the run status + open
  // decisions. The cancelled status specifically yields `"stop"` — a
  // cancelled run should not be auto-resumed.
  const nextAction: HandoffNextAction = (() => {
    if (runStatus === "cancelled") return "stop";
    if (runStatus === "queued" || runStatus === "running") return "continue";
    // terminal: completed / failed
    return openDecisions.length > 0 ? "handoff" : "new-attempt";
  })();

  const excludes: HandoffExcludes = { nativeState: true, transcripts: true };
  const capturedAt = new Date().toISOString();
  const crossProvider = parsed.crossProvider ?? false;
  const draft = {
    runId: parsed.runId,
    capturedAt,
    sourceRevision,
    targetRevision,
    crossProvider,
    objective,
    verifiedState,
    artifacts: artifactSlice,
    remainingDecisions: decisionSlice,
    remainingResources: resourceSlice,
    nextAction,
    excludes,
  };
  // The audit digest intentionally EXCLUDES `capturedAt`. Re-callers
  // reading the same handoff-shape across time get a stable digest;
  // the captured timestamp is recorded in the envelope itself. This
  // mirrors the M4.5 snapshot rule (drift detection is content
  // equality, not "captured at this exact millisecond").
  const digest = createHash("sha256")
    .update(stableStringify({ ...draft, capturedAt: "", digest: "" }), "utf8")
    .digest("hex");
  return handoffSchema.parse({ ...draft, digest });
}

/** Extract a human-readable prompt from an attention item's `payloadJson`. */
function extractPrompt(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { prompt?: unknown };
    if (typeof parsed.prompt === "string") return parsed.prompt.slice(0, 2048);
  } catch {
    // fall through
  }
  return "";
}

function extractOpenedBy(payloadJson: string): string {
  try {
    const parsed = JSON.parse(payloadJson) as { openedBy?: unknown };
    if (typeof parsed.openedBy === "string") return parsed.openedBy;
  } catch {
    // fall through
  }
  return "system";
}
