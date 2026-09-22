/**
 * M3c.5 — managed-work user actions: `answer`, `continue`, `new-attempt`,
 * `stop` seams consumed by the renderer's action buttons + hotkeys.
 *
 * `answer`/`continue` re-use the M3c.3 `attention_item` model: a
 * `kind: "decision"` row in the open inbox is the durable "this run is
 * waiting" signal. `answer` records a human reply (raising a new
 * decision row at `revision + 1` with the reply in `payload_json`).
 * `continue` resolves the open decision AND follows up with
 * `executeOnce` to spawn a fresh invocation — same provider identity,
 * new `attempt` number, fresh `idempotencyKey`.
 *
 * `new-attempt` skips the attention step: it's the explicit "I'm not
 * waiting for anything, just spawn a fresh attempt" path, used both
 * for ad-hoc retries and as the "I read the answer, please continue"
 * confirmation when the original decision resolves at the answer time.
 *
 * `stop` is a thin seam over the existing `requestStop` orchestrator;
 * the runtime knows how to flip the run row and block future
 * `executeOnce` calls for that run.
 *
 * All four actions return the same `{kind: "ok", ...} | {kind:
 * "conflict", reason}` envelope the renderer's other managed buttons
 * consume; ambiguous dispatches from `executeOnce` are mapped to
 * `conflict` at the boundary.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { AttentionItem } from "../../shared/managed";
import type { DbWorker } from "../db/worker";
import {
  raiseAttention,
  readAttention,
  transitionAttention,
} from "../db/attention-items";
import { listInvocationsForRun } from "../db/invocations";
import { listRunsForTask, readRun } from "../db/runs";
import {
  type ExecuteOnceInput,
  type ExecuteOnceResult,
  executeOnce,
} from "./execute-once";
import {
  type RequestStopInput,
  isStopped as isStoppedInOrchestrator,
  requestStop as requestStopImpl,
} from "./stop-policy";
import { retryPolicySchema } from "./retry-policy";

// ── `answer` ────────────────────────────────────────────────────────────────

const ANSWER_INPUT = z.object({
  reply: z.string().min(1).max(64 * 1024),
  answeredBy: z.string().min(1).max(256),
}).strict();
export type AnswerAttentionInput = z.input<typeof ANSWER_INPUT>;

export interface AnswerAttentionOk {
  readonly kind: "ok";
  readonly resolvedItem: AttentionItem;
  readonly followUpItem: AttentionItem | null;
}

/**
 * Resolve an open `decision` attention item with a human reply and
 * raise the next-revision `decision` row carrying the reply in its
 * `payload_json`. The new row becomes the durable audit anchor for
 * the answer; the resolver can decide whether to follow up with
 * `continueInvocation` or `newAttempt` based on the reply contents.
 */
export async function answerAttention(
  worker: DbWorker,
  id: string,
  input: AnswerAttentionInput,
): Promise<AnswerAttentionOk> {
  const parsedId = z.string().uuid().parse(id);
  const parsed = ANSWER_INPUT.parse(input);
  const existing = await readAttention(worker, parsedId);
  if (!existing) throw new AppError("NOT_FOUND", "Attention item not found");
  // M7.7 — `schedule-decision` is answered the same way as `decision`
  // (the renderer surfaces it with the same "answer" affordance).
  if (existing.kind !== "decision" && existing.kind !== "schedule-decision")
    throw new AppError(
      "CONFLICT",
      `Answer can only resolve a "decision" or "schedule-decision" item; this one is "${existing.kind}"`,
    );
  if (existing.state === "resolved" || existing.state === "dismissed")
    throw new AppError(
      "CONFLICT",
      `Attention item is already ${existing.state}; cannot answer again`,
    );

  // Resolve the open row first.
  const resolved = await transitionAttention(worker, parsedId, "resolved");

  // Raise the next-revision reply row under a stable issue identity
  // so the M3c.3 inbox surfaces a single "answered decision" entry
  // alongside the original. The reply lands in `payload_json`.
  // M7.7 — preserve the resolved kind so a `schedule-decision` row
  // is answered as a `schedule-decision` (the renderer surfaces both
  // with the same answer affordance; collapsing the follow-up into a
  // generic `decision` would lose that distinction).
  const followUp = await raiseAttention(worker, {
    taskId: resolved.taskId,
    kind: resolved.kind,
    issueIdentity: resolved.issueIdentity,
    revision: resolved.revision + 1,
    payload: {
      reply: parsed.reply,
      answeredBy: parsed.answeredBy,
      answeredAt: new Date().toISOString(),
    },
  });

  return {
    kind: "ok",
    resolvedItem: resolved,
    followUpItem: followUp,
  };
}

// ── `continue` ───────────────────────────────────────────────────────────────

const CONTINUE_INPUT = z.object({
  providerVersion: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  args: z.unknown().default({}),
  scope: z.unknown().default({}),
  deadlineAt: z.string().datetime(),
  attemptedBy: z.string().min(1).max(256),
}).strict();
export type ContinueInvocationInput = z.input<typeof CONTINUE_INPUT>;

export interface ActionOk {
  readonly kind: "ok";
  readonly invocationId: string;
  readonly dispatchIntentId: string;
  readonly attentionId: string;
}

export interface ActionConflict {
  readonly kind: "conflict";
  readonly reason: string;
}

export type ContinueInvocationResult = ActionOk | ActionConflict;

/**
 * Resolve an open `decision` item AND spawn a continuation invocation
 * via `executeOnce`. The new invocation carries the original
 * `idempotencyKey` is replaced with a fresh
 * `"continue:<runId>:<attentionId>:<now()>"` key (deterministic on
 * the inputs), incremented `attempt`, and `parentInvocationId`
 * pointing at the previous invocation.
 */
export async function continueInvocation(
  worker: DbWorker,
  attentionId: string,
  input: ContinueInvocationInput,
): Promise<ContinueInvocationResult> {
  const parsedAttentionId = z.string().uuid().parse(attentionId);
  const parsed = CONTINUE_INPUT.parse(input);
  const existing = await readAttention(worker, parsedAttentionId);
  if (!existing) throw new AppError("NOT_FOUND", "Attention item not found");
  if (existing.kind !== "decision")
    throw new AppError("CONFLICT", `Continue expects a "decision" item; got "${existing.kind}"`);
  if (existing.state === "resolved" || existing.state === "dismissed")
    throw new AppError("CONFLICT", `Attention item is already ${existing.state}; cannot continue`);

  // Resolve the decision row before spawning the continuation so the
  // renderer doesn't see two open decisions for the same issue.
  const resolved = await transitionAttention(worker, parsedAttentionId, "resolved");

  if (!existing.taskId)
    throw new AppError("CONFLICT", "Cannot continue without a task; raise the attention item against a task first");

  const runs = await listRunsForTask(worker, existing.taskId);
  const run = runs[runs.length - 1];
  if (!run) throw new AppError("NOT_FOUND", "No run for task; cannot continue");

  return await spawnFollowingInvocation(worker, run.id, {
    providerVersion: parsed.providerVersion,
    model: parsed.model,
    accountMode: parsed.accountMode,
    args: parsed.args,
    scope: parsed.scope,
    deadlineAt: parsed.deadlineAt,
    idempotencyKey: buildIdempotencyKey("continue", run.id, parsedAttentionId, Date.now()),
    method: "execute-once",
    extra: { continuedFromAttentionId: parsedAttentionId, attemptedBy: parsed.attemptedBy },
    attentionId: resolved.id,
  });
}

// ── `new-attempt` ───────────────────────────────────────────────────────────

const NEW_ATTEMPT_INPUT = z.object({
  runId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(1).max(256),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  method: z.string().min(1).max(128),
  args: z.unknown().default({}),
  scope: z.unknown().default({}),
  deadlineAt: z.string().datetime(),
  requestedBy: z.string().min(1).max(256),
  /**
   * M7.4 — optional retry policy. When omitted, the new attempt
   * inherits the previous invocation's policy (or the default
   * no-retry policy if none was recorded).
   */
  retryPolicy: retryPolicySchema.optional(),
}).strict();
export type NewAttemptInput = z.input<typeof NEW_ATTEMPT_INPUT>;

export type NewAttemptResult = ActionOk | ActionConflict;

/**
 * Spawn a fresh invocation for the supplied run. The renderer's
 * "New attempt" button is the only legitimate caller today; the
 * orchestrator refuses an attempt when the run is stopped (the
 * `requestStop` policy sets the per-run stop flag).
 *
 * `parentInvocationId` is recorded in the dispatch_intent lineage
 * even though it's not a column on `invocation` (see D-4 in
 * the M3c.5 plan). The caller supplies the new `idempotencyKey`
 *; the orchestrator's idem dedupe prevents a stray replay.
 */
export async function newAttempt(
  worker: DbWorker,
  input: NewAttemptInput,
): Promise<NewAttemptResult> {
  const parsed = NEW_ATTEMPT_INPUT.parse(input);
  const run = await readRun(worker, parsed.runId);
  if (!run) throw new AppError("NOT_FOUND", "Run not found");
  if (run.status === "cancelled" || run.status === "completed" || run.status === "failed")
    throw new AppError(
      "CONFLICT",
      `Run is ${run.status}; spawn a new run instead of using this one`,
    );

  return await spawnFollowingInvocation(worker, parsed.runId, {
    providerVersion: parsed.providerVersion,
    model: parsed.model,
    accountMode: parsed.accountMode,
    args: parsed.args,
    scope: parsed.scope,
    deadlineAt: parsed.deadlineAt,
    idempotencyKey: parsed.idempotencyKey,
    canonicalDigest: parsed.canonicalDigest,
    method: parsed.method,
    retryPolicy: parsed.retryPolicy,
  });
}

interface FollowingInvocationArgs {
  providerVersion: string;
  model: string;
  accountMode: "anonymous" | "authenticated" | "trusted-host";
  args: unknown;
  scope: unknown;
  deadlineAt: string;
  idempotencyKey: string;
  canonicalDigest?: string;
  method: string;
  extra?: Record<string, unknown>;
  attentionId?: string;
  retryPolicy?: ExecuteOnceInput["retryPolicy"];
}

async function spawnFollowingInvocation(
  worker: DbWorker,
  runId: string,
  args: FollowingInvocationArgs,
): Promise<ActionOk | ActionConflict> {
  const previous = await listInvocationsForRun(worker, runId);
  const parentInvocationId = previous.length > 0 ? previous[previous.length - 1].id : null;

  const digest = args.canonicalDigest ?? "0".repeat(64);

  const executeInput: ExecuteOnceInput = {
    runId,
    idempotencyKey: args.idempotencyKey,
    canonicalDigest: digest,
    providerVersion: args.providerVersion,
    model: args.model,
    accountMode: args.accountMode,
    method: args.method,
    args: { ...(args.args as Record<string, unknown> | undefined ?? {}), ...(args.extra ?? {}) },
    scope: args.scope,
    deadlineAt: args.deadlineAt,
    parentInvocationId,
    revision: null,
    retryPolicy: args.retryPolicy,
  };
  // The orchestrator's `createInvocation` derives the next attempt
  // number internally from the run's invocations; the dispatch_intent
  // row records args/parentInvocationId in `args_json` (M3b.2).
  const result: ExecuteOnceResult = await executeOnce(worker, executeInput);
  if (result.kind === "conflict")
    return { kind: "conflict", reason: result.reason };
  if (result.kind === "ambiguous")
    return {
      kind: "conflict",
      reason: result.reason || `Invocation ${result.invocationId} is ambiguous; cannot retry`,
    };
  // result.kind === "ok"
  return {
    kind: "ok",
    invocationId: result.invocationId,
    dispatchIntentId: result.dispatchIntentId,
    attentionId: args.attentionId ?? "",
  };
}

// ── `stop` ──────────────────────────────────────────────────────────────────

export const REQUEST_STOP_INPUT = z.object({
  reason: z.string().min(1).max(256),
  requestedBy: z.string().min(1).max(256),
}).strict();
export type RequestStopActionInput = z.input<typeof REQUEST_STOP_INPUT>;

export interface RequestStopActionOk {
  readonly kind: "ok";
  readonly runId: string;
  readonly status: "cancelled";
  readonly blockedExecuteOnce: true;
}

export interface RequestStopActionConflict {
  readonly kind: "conflict";
  readonly reason: string;
}

export type RequestStopActionResult = RequestStopActionOk | RequestStopActionConflict;

/**
 * Stop a run. Thin wrapper over `requestStop` that surfaces a
 * structured conflict envelope (matching the other managed-work
 * buttons) and never throws `AppError` to the caller.
 *
 * The runtime's `requestStop` is idempotent on terminal runs and
 * never throws on a legitimate state transition, so the action
 * always returns `kind: "ok"`. The `Result` union is kept for
 * callers that want to handle the (currently unused) conflict
 * branch uniformly with the other managed-work actions.
 */
export async function requestRunStop(
  worker: DbWorker,
  runId: string,
  input: RequestStopActionInput,
): Promise<RequestStopActionOk> {
  const parsedId = z.string().uuid().parse(runId);
  const parsed = REQUEST_STOP_INPUT.parse(input);
  const stopInput: RequestStopInput = {
    runId: parsedId,
    reason: parsed.reason,
    requestedBy: parsed.requestedBy,
  };
  const result = await requestStopImpl(worker, stopInput);
  return {
    kind: "ok",
    runId: result.runId,
    status: result.status,
    blockedExecuteOnce: result.blockedExecuteOnce,
  };
}

/** Test seam: was this run already requested to stop? */
export function isRunStopped(runId: string): boolean {
  return isStoppedInOrchestrator(runId);
}

/** Build a stable, content-derived idempotency key for continuation seeds. */
function buildIdempotencyKey(prefix: string, runId: string, attentionId: string, nowMs: number): string {
  const trimmed = `${prefix}:${runId}:${attentionId}:${nowMs}`;
  if (trimmed.length <= 256) return trimmed;
  return trimmed.slice(0, 256);
}

// ── M5.5 re-exports ──────────────────────────────────────────────────────────
// The M5.5 attachment registry is consumed by the M5.1 facade in a future
// transport-wiring increment; expose it here so the seam is a single
// import path. Schema imports keep the trust model co-located with the
// runtime orchestration surface.

export {
  createAttachmentRegistry,
  DEFAULT_OBSERVER_BYTE_CREDITS,
  DEFAULT_OWNER_BYTE_CREDITS,
  REPLAY_BUFFER_BYTES,
  OWNERSHIP_HANDOVER_TIMEOUT_MS,
  SUBSCRIPTION_ROW_META_PREFIX,
  OWNERSHIP_ROW_META_PREFIX,
  ABANDONED_ROW_META_PREFIX,
  registerAttachmentInputSchema,
  subscriptionStateSchema,
  publishOutputInputSchema,
  requestResizeInputSchema,
  sendInputInputSchema,
  transferOwnershipInputSchema,
  acknowledgeOutputInputSchema,
  unregisterAttachmentInputSchema,
  replenishByteCreditsInputSchema,
  attachmentRegistryStatusSchema,
} from "./attachment-registry";
export type {
  AttachmentRegistry,
  AttachmentRegistryDeps,
  RegisterResult,
  UnregisterResult,
  PublishResult,
  ResizeResult,
  SendInputResult,
  TransferResult,
  AcknowledgeResult,
  ReplenishResult,
  HandoverResult,
} from "./attachment-registry";
