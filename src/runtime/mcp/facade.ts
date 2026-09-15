/**
 * M5.1 — narrow management CLI/MCP facade.
 *
 * The facade exposes a typed, principal-bound slice of the runtime
 * API for an automated caller (CLI / MCP client / lead agent). It
 * deliberately omits every raw shell / keystroke administration
 * method (`attach`, `input`, `cancel-input`, `rename-terminal`,
 * `delete-terminal`, `launch-terminals`, `create-terminals`, file
 * operations, settings / preset / env-profile management); a
 * future M5.1 increment may add a strictly-bounded
 * `attachTerminal` for read-only observability, but the present
 * facade is a *management* surface, not a *control* surface.
 *
 * The trust model is "principal-bound, project-narrowed, never
 * enlarged by agent-supplied identifiers":
 *
 *  - The caller-supplied `McpContext` carries a `principal` (an
 *    opaque user / agent identifier bound at the connection's
 *    handshake) and a `projectIds` list (the projects the
 *    principal is permitted to manage). The transport verifies
 *    the principal at handshake time; the runtime does not trust
 *    the principal in isolation.
 *  - Every read / write method rejects when the supplied
 *    `projectId` is not in `McpContext.projectIds` *or* when a
 *    row's resolved project id is not in `McpContext.projectIds`.
 *    An agent-supplied project id therefore never enlarges
 *    access — the worst it can do is throw `FORBIDDEN`.
 *  - Read methods are bounded (`mcpTaskSummarySchema` /
 *    `mcpRunSummarySchema` / `mcpArtifactSummarySchema` cap
 *    distinct result rows). `previewArtifact` reuses the existing
 *    M3c.3 grant gate so the body is still capped at 8 KiB AND
 *    requires an `approved` grant for `(principal, sha256)`.
 *  - Write methods produce structured `{kind: "ok"} | {kind:
 *    "forbidden", reason}` envelopes that never leak `AppError`
 *    to the caller (the facade maps `AppError("FORBIDDEN", …)`
 *    to `kind: "forbidden"` and other `AppError` codes to the
 *    nearest caller-visible envelope).
 *
 * The facade does not register any IPC method by itself — the
 * future CLI / MCP transport wires a dispatcher to the exported
 * functions. The runtime treats this module as the single
 * management-surface authority.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { previewArtifact, listArtifacts, readArtifact } from "../db/artifact-references";
import { createTask, listTasks, readTask as readTaskRow } from "../db/tasks";
import { listInvocationsForRun } from "../db/invocations";
import { listRunsForTask, readRun as readRunRow } from "../db/runs";
import { requestRunStop } from "../orchestration/managed-actions";
import { mcpContextSchema, mcpTaskSummarySchema, mcpRunSummarySchema,
  mcpInvocationSummarySchema, mcpArtifactSummarySchema,
  type McpContext, type McpTaskSummary, type McpRunSummary,
  type McpInvocationSummary, type McpArtifactSummary } from "../../shared/mcp-schema";
import type { DbWorker } from "../db/worker";
import { stableStringify } from "../db/effective-settings";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Pure helper: does the agent-supplied `projectId` match the
 * principal's permitted `projectIds`? Returns the resolved
 * project id (canonical, trimmed) when permitted; throws
 * `AppError("FORBIDDEN", …)` otherwise. The transport layer
 * should call this with the row's resolved project id, never
 * with an agent-supplied one.
 */
function requirePermittedProject(
  ctx: McpContext,
  resolvedProjectId: string,
  action: string,
): string {
  const principal = z.string().trim().min(1).max(256).parse(ctx.principal);
  const projectIds = z.array(z.string().trim().min(1).max(256))
    .min(1).max(64).parse(ctx.projectIds);
  const resolved = resolvedProjectId.trim();
  if (!resolved) {
    throw new AppError("FORBIDDEN",
      `${action}: empty project id is not permitted`);
  }
  const set = new Set(projectIds);
  if (!set.has(resolved)) {
    // Content-addressed refusal: stable across reruns so a
    // client audit log dedupes repeated attempts.
    const digest = createHash("sha256")
      .update(stableStringify({
        principal, projectId: resolved, permitted: [...set].sort(),
        payloadDigest: "",
      }), "utf8").digest("hex");
    throw new AppError("FORBIDDEN",
      `${action}: project "${resolved}" is not in principal "${principal}"'s permitted set (refusal-digest: ${digest.slice(0, 16)})`);
  }
  return resolved;
}

function taskToSummary(task: Awaited<ReturnType<typeof readTaskRow>>): McpTaskSummary {
  if (!task) throw new AppError("UNAVAILABLE", "Task row missing after read");
  return mcpTaskSummarySchema.parse({
    id: task.id,
    title: task.title,
    status: task.status,
    projectId: task.projectId,
    hostId: task.hostId,
    providerVersion: task.providerVersion,
    model: task.model,
    accountMode: task.accountMode,
    baseIdentity: task.baseIdentity,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

function runToSummary(run: NonNullable<Awaited<ReturnType<typeof readRunRow>>>): McpRunSummary {
  return mcpRunSummarySchema.parse({
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    baseRevision: run.baseRevision,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
}

function invocationToSummary(row: Awaited<ReturnType<typeof listInvocationsForRun>>[number]): McpInvocationSummary {
  return mcpInvocationSummarySchema.parse({
    id: row.id,
    runId: row.runId,
    attempt: row.attempt,
    status: row.status,
    providerVersion: row.providerVersion,
    model: row.model,
    accountMode: row.accountMode,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    createdAt: row.createdAt,
  });
}

function artifactToSummary(row: Awaited<ReturnType<typeof listArtifacts>>[number]): McpArtifactSummary {
  return mcpArtifactSummarySchema.parse({
    id: row.id,
    taskId: row.taskId,
    runId: row.runId,
    uri: row.uri,
    sha256: row.sha256,
    kind: row.kind,
    bytes: row.bytes,
    mime: row.mime,
    importedAt: row.importedAt,
    expiresAt: row.expiresAt,
  });
}

// ── Read paths ───────────────────────────────────────────────────────────────

export interface McpListTasksOk {
  readonly tasks: ReadonlyArray<McpTaskSummary>;
  /** Project IDs the agent asked about but the principal wasn't permitted to see. */
  readonly deniedProjectIds: ReadonlyArray<string>;
}

export async function mcpListTasks(
  worker: DbWorker,
  context: McpContext,
  filter?: { status?: "draft" | "ready" | "active" | "done" | "abandoned" },
): Promise<McpListTasksOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedFilter = filter
    ? z.object({
      status: z.enum(["draft", "ready", "active", "done", "abandoned"]).optional(),
    }).strict().parse(filter)
    : undefined;
  // Use the existing listTasks from db/tasks — then apply the
  // principal's project filter on the result. We deliberately do
  // NOT pass the agent's request through `filter.projectId`; the
  // principal's permitted set is the gate.
  const all = await listTasks(worker, parsedFilter?.status ? { status: parsedFilter.status } : undefined);
  const permitted = new Set(ctx.projectIds);
  const visible: McpTaskSummary[] = [];
  const denied = new Set<string>();
  for (const task of all) {
    if (!permitted.has(task.projectId)) {
      denied.add(task.projectId);
      continue;
    }
    visible.push(taskToSummary(task));
  }
  return {
    tasks: visible,
    deniedProjectIds: [...denied].sort(),
  };
}

export interface McpReadTaskOk {
  readonly task: McpTaskSummary;
  readonly runs: ReadonlyArray<McpRunSummary>;
}

export async function mcpReadTask(
  worker: DbWorker,
  context: McpContext,
  taskId: string,
): Promise<McpReadTaskOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedId = z.string().uuid().parse(taskId);
  const task = await readTaskRow(worker, parsedId);
  if (!task) throw new AppError("NOT_FOUND", `Task ${parsedId} not found`);
  // Task project is the gate, not the agent-supplied filter.
  requirePermittedProject(ctx, task.projectId, "mcp-read-task");
  const runs = await listRunsForTask(worker, parsedId);
  return {
    task: taskToSummary(task),
    runs: runs.map(runToSummary),
  };
}

export interface McpListRunsOk {
  readonly runs: ReadonlyArray<McpRunSummary>;
}

export async function mcpListRuns(
  worker: DbWorker,
  context: McpContext,
  taskId: string,
): Promise<McpListRunsOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedId = z.string().uuid().parse(taskId);
  const task = await readTaskRow(worker, parsedId);
  if (!task) throw new AppError("NOT_FOUND", `Task ${parsedId} not found`);
  requirePermittedProject(ctx, task.projectId, "mcp-list-runs");
  const runs = await listRunsForTask(worker, parsedId);
  return { runs: runs.map(runToSummary) };
}

export interface McpReadRunOk {
  readonly run: McpRunSummary;
  readonly invocations: ReadonlyArray<McpInvocationSummary>;
}

export async function mcpReadRun(
  worker: DbWorker,
  context: McpContext,
  runId: string,
): Promise<McpReadRunOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedId = z.string().uuid().parse(runId);
  const run = await readRunRow(worker, parsedId);
  if (!run) throw new AppError("NOT_FOUND", `Run ${parsedId} not found`);
  const task = await readTaskRow(worker, run.taskId);
  if (!task) throw new AppError("NOT_FOUND", `Task ${run.taskId} not found for run ${parsedId}`);
  requirePermittedProject(ctx, task.projectId, "mcp-read-run");
  const invocations = await listInvocationsForRun(worker, parsedId);
  return {
    run: runToSummary(run),
    invocations: invocations.map(invocationToSummary),
  };
}

export interface McpListArtifactsOk {
  readonly artifacts: ReadonlyArray<McpArtifactSummary>;
}

export async function mcpListArtifacts(
  worker: DbWorker,
  context: McpContext,
  filter?: { kind?: "input" | "context" | "evidence" | "output"; taskId?: string },
): Promise<McpListArtifactsOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedFilter = filter
    ? z.object({
      kind: z.enum(["input", "context", "evidence", "output"]).optional(),
      taskId: z.string().uuid().optional(),
    }).strict().parse(filter)
    : undefined;
  if (parsedFilter?.taskId) {
    // Bounded by task project before enumeration.
    const task = await readTaskRow(worker, parsedFilter.taskId);
    if (!task) throw new AppError("NOT_FOUND", `Task ${parsedFilter.taskId} not found`);
    requirePermittedProject(ctx, task.projectId, "mcp-list-artifacts");
  }
  const all = await listArtifacts(worker);
  const permitted = new Set(ctx.projectIds);
  const visible: McpArtifactSummary[] = [];
  for (const row of all) {
    // An artifact without a taskId is not project-bound; we hide
    // it from the management surface entirely (the renderer still
    // sees it via the M3c.3 previewArtifact path, which carries
    // its own grant gate).
    if (!row.taskId) continue;
    const task = await readTaskRow(worker, row.taskId);
    if (!task) continue;
    if (!permitted.has(task.projectId)) continue;
    if (parsedFilter?.kind && row.kind !== parsedFilter.kind) continue;
    visible.push(artifactToSummary(row));
  }
  return { artifacts: visible };
}

export interface McpPreviewArtifactOk {
  readonly id: string;
  readonly sha256: string;
  readonly mime: string;
  readonly bytes: number;
  readonly truncated: boolean;
  readonly truncatedBase64Content: string;
}

export async function mcpPreviewArtifact(
  worker: DbWorker,
  context: McpContext,
  artifactId: string,
  scopeJson: string | null = null,
): Promise<McpPreviewArtifactOk> {
  const ctx = mcpContextSchema.parse(context);
  const parsedId = z.string().uuid().parse(artifactId);
  // Read the artifact first so we can resolve its project via
  // the underlying task. The principal is forwarded to the
  // existing grant gate.
  const artifact = await readArtifact(worker, parsedId);
  if (!artifact) throw new AppError("NOT_FOUND", `Artifact ${parsedId} not found`);
  if (!artifact.taskId) {
    // Project-free artifacts are not surfaced through the
    // management facade; the renderer's preview path is for
    // them.
    throw new AppError("FORBIDDEN",
      "mcp-preview-artifact: artifact has no task scope; use the renderer preview path");
  }
  const task = await readTaskRow(worker, artifact.taskId);
  if (!task) throw new AppError("NOT_FOUND", `Task ${artifact.taskId} not found`);
  requirePermittedProject(ctx, task.projectId, "mcp-preview-artifact");
  const preview = await previewArtifact(worker, {
    id: parsedId,
    principal: ctx.principal,
    scopeJson,
  });
  return {
    id: preview.id,
    sha256: preview.sha256,
    mime: preview.mime,
    bytes: preview.bytes,
    truncated: preview.truncated,
    truncatedBase64Content: preview.truncatedBase64Content,
  };
}

// ── Write paths ─────────────────────────────────────────────────────────────

export type McpCreateTaskResult =
  | { readonly kind: "ok"; readonly task: McpTaskSummary }
  | { readonly kind: "forbidden"; readonly reason: string };

export async function mcpCreateTask(
  worker: DbWorker,
  context: McpContext,
  input: {
    title: string;
    objective?: string;
    projectId: string;
    hostId: string;
    providerVersion?: string | null;
    model?: string | null;
    accountMode?: "anonymous" | "authenticated" | "trusted-host" | null;
    baseIdentity?: string | null;
    rootIdentity?: string | null;
    effectiveInputs?: Record<string, unknown> | null;
  },
): Promise<McpCreateTaskResult> {
  const ctx = mcpContextSchema.parse(context);
  const parsed = z.object({
    title: z.string().trim().min(1).max(200),
    objective: z.string().max(8000).default(""),
    projectId: z.string().trim().min(1).max(256),
    hostId: z.string().trim().min(1).max(128),
    providerVersion: z.string().min(1).max(256).nullable().default(null),
    model: z.string().min(1).max(256).nullable().default(null),
    accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable().default(null),
    baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
    rootIdentity: z.string().regex(/^\d+:\d+$/).nullable().default(null),
    effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable().default(null),
  }).strict().parse(input);
  // Refuse BEFORE row insertion. requirePermittedProject throws
  // `AppError("FORBIDDEN", …)`; we map to the structured envelope.
  let resolved: string;
  try {
    resolved = requirePermittedProject(ctx, parsed.projectId, "mcp-create-task");
  } catch (error) {
    if (error instanceof AppError) return { kind: "forbidden", reason: error.message };
    throw error;
  }
  const created = await createTask(worker, {
    title: parsed.title,
    objective: parsed.objective,
    projectId: resolved,
    hostId: parsed.hostId,
    providerVersion: parsed.providerVersion,
    model: parsed.model,
    accountMode: parsed.accountMode,
    baseIdentity: parsed.baseIdentity,
    rootIdentity: parsed.rootIdentity,
    effectiveInputs: parsed.effectiveInputs,
  });
  return { kind: "ok", task: taskToSummary(created.task) };
}

export type McpRequestStopResult =
  | { readonly kind: "ok"; readonly runId: string; readonly status: "cancelled"; readonly blockedExecuteOnce: true }
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "not-found"; readonly reason: string };

export async function mcpRequestStop(
  worker: DbWorker,
  context: McpContext,
  input: { runId: string; reason: string; requestedBy?: string },
): Promise<McpRequestStopResult> {
  const ctx = mcpContextSchema.parse(context);
  const parsed = z.object({
    runId: z.string().uuid(),
    reason: z.string().trim().min(1).max(256),
    requestedBy: z.string().trim().min(1).max(256).optional(),
  }).strict().parse(input);
  const run = await readRunRow(worker, parsed.runId);
  if (!run) return { kind: "not-found", reason: `Run ${parsed.runId} not found` };
  const task = await readTaskRow(worker, run.taskId);
  if (!task) return { kind: "not-found", reason: `Task ${run.taskId} not found for run ${parsed.runId}` };
  try {
    requirePermittedProject(ctx, task.projectId, "mcp-request-stop");
  } catch (error) {
    if (error instanceof AppError) return { kind: "forbidden", reason: error.message };
    throw error;
  }
  const result = await requestRunStop(worker, parsed.runId, {
    reason: parsed.reason,
    requestedBy: parsed.requestedBy ?? ctx.principal,
  });
  return {
    kind: "ok",
    runId: result.runId,
    status: result.status,
    blockedExecuteOnce: true,
  };
}
