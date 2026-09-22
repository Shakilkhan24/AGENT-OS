/**
 * M5.1 — narrow management CLI/MCP facade IPC schemas.
 *
 * The M5.1 facade exposes only a typed, principal-bound slice of the
 * runtime API. Every method takes a `principal` argument and a
 * `projectIds` argument; the runtime intersects the agent-supplied
 * project IDs with the principal's permitted project IDs, so an
 * agent-supplied project ID can never enlarge access. Raw shell /
 * keystroke administration (`attach`, `input`, `cancel-input`,
 * `rename-terminal`, `delete-terminal`, `launch-terminals`,
 * `create-terminals`, file operations, settings/preset/env-profile
 * management) is deliberately absent — the facade is a
 * management surface, not a control surface.
 *
 * Read methods:
 *   `mcp-list-tasks`, `mcp-read-task`, `mcp-list-runs`,
 *   `mcp-read-run`, `mcp-list-artifacts`, `mcp-preview-artifact`
 *
 * Write methods:
 *   `mcp-create-task`, `mcp-request-stop`
 *
 * Recipe requests are deferred to M6 (the M5.1 bullet explicitly
 * notes "enable recipe requests when M6 lands").
 *
 * Wire shapes mirror the existing `managed-schema.ts` IPC
 * pattern: tuple inputs and explicit result schemas. The
 * facade refuses with `FORBIDDEN` (returned as a structured
 * `{kind: "forbidden", reason}` envelope on write paths, or
 * as `AppError("FORBIDDEN", …)` on read paths) when the
 * supplied `projectId` is not in the principal's permitted
 * set, when the principal is empty, or when a write would
 * cross a project boundary.
 */
import { z } from "zod";

const principalSchema = z.string().trim().min(1).max(256);
const projectIdSchema = z.string().trim().min(1).max(256);

/**
 * The principal-bound context supplied by the authenticated
 * caller. The facade never trusts the agent on its own —
 * `projectIds` is the intersection the principal was bound
 * to at handshake time.
 */
export const mcpContextSchema = z.object({
  principal: principalSchema,
  projectIds: z.array(projectIdSchema).min(1).max(64),
}).strict();
export type McpContext = z.input<typeof mcpContextSchema>;

// ── Read paths ───────────────────────────────────────────────────────────────

/** Args: `[mcpContext, filter?]`. Lists tasks within the principal's projects. */
export const mcpListTasksInputSchema = z.tuple([
  mcpContextSchema,
  z.object({
    status: z.enum(["draft", "ready", "active", "done", "abandoned"]).optional(),
  }).strict().optional(),
]);

export const mcpTaskSummarySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(200),
  status: z.enum(["draft", "ready", "active", "done", "abandoned"]),
  projectId: z.string().max(256),
  hostId: z.string().min(1).max(128),
  providerVersion: z.string().nullable(),
  model: z.string().nullable(),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable(),
  baseIdentity: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type McpTaskSummary = z.infer<typeof mcpTaskSummarySchema>;

export const mcpListTasksResultSchema = z.object({
  tasks: z.array(mcpTaskSummarySchema).max(1024),
  /** Project IDs the agent requested that the principal was not permitted to see. */
  deniedProjectIds: z.array(projectIdSchema).max(64),
}).strict();

/** Args: `[mcpContext, taskId]`. Refuses with FORBIDDEN if the task's project is not permitted. */
export const mcpReadTaskInputSchema = z.tuple([
  mcpContextSchema,
  z.string().uuid(),
]);

/** Result: full task view + run summary list. */
export const mcpRunSummarySchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  status: z.enum(["queued", "running", "completed", "cancelled", "failed"]),
  baseRevision: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type McpRunSummary = z.infer<typeof mcpRunSummarySchema>;

export const mcpReadTaskResultSchema = z.object({
  task: z.object({
    id: z.string().uuid(),
    title: z.string().min(1).max(200),
    objective: z.string().max(8000),
    status: z.enum(["draft", "ready", "active", "done", "abandoned"]),
    projectId: z.string().max(256),
    hostId: z.string().min(1).max(128),
    providerVersion: z.string().nullable(),
    model: z.string().nullable(),
    accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable(),
    baseIdentity: z.string().nullable(),
    rootIdentity: z.string().nullable(),
    effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  }).strict(),
  runs: z.array(mcpRunSummarySchema).max(256),
}).strict();

/** Args: `[mcpContext, taskId]`. Lists runs for the principal's task. */
export const mcpListRunsInputSchema = z.tuple([
  mcpContextSchema,
  z.string().uuid(),
]);
export const mcpListRunsResultSchema = z.object({
  runs: z.array(mcpRunSummarySchema).max(256),
}).strict();

/** Args: `[mcpContext, runId]`. Refuses with FORBIDDEN if the run's task project is not permitted. */
export const mcpReadRunInputSchema = z.tuple([
  mcpContextSchema,
  z.string().uuid(),
]);

export const mcpInvocationSummarySchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  attempt: z.number().int().min(1).max(1024),
  status: z.enum(["pending", "admitted", "spawned", "observing", "done", "error"]),
  providerVersion: z.string().min(1).max(256),
  model: z.string().min(1).max(256),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  startedAt: z.string().datetime().nullable(),
  endedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
}).strict();
export type McpInvocationSummary = z.infer<typeof mcpInvocationSummarySchema>;

export const mcpReadRunResultSchema = z.object({
  run: mcpRunSummarySchema,
  invocations: z.array(mcpInvocationSummarySchema).max(256),
}).strict();

/** Args: `[mcpContext, filter?]`. Lists artifacts within the principal's projects. */
export const mcpListArtifactsInputSchema = z.tuple([
  mcpContextSchema,
  z.object({
    kind: z.enum(["input", "context", "evidence", "output"]).optional(),
    taskId: z.string().uuid().optional(),
  }).strict().optional(),
]);

export const mcpArtifactSummarySchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  runId: z.string().uuid().nullable(),
  uri: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: z.enum(["input", "context", "evidence", "output"]),
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(256),
  importedAt: z.string().datetime(),
  expiresAt: z.string().datetime().nullable(),
}).strict();
export type McpArtifactSummary = z.infer<typeof mcpArtifactSummarySchema>;

export const mcpListArtifactsResultSchema = z.object({
  artifacts: z.array(mcpArtifactSummarySchema).max(1024),
}).strict();

/**
 * Args: `[mcpContext, artifactId, scopeJson?]`. The facade
 * delegates to the existing `previewArtifact` gated read path
 * with the principal from `mcpContext`; an agent-supplied
 * `scopeJson` is forwarded (the existing grant gate
 * re-validates it).
 */
export const mcpPreviewArtifactInputSchema = z.tuple([
  mcpContextSchema,
  z.string().uuid(),
  z.string().max(64 * 1024).nullable().optional(),
]);

export const mcpPreviewArtifactResultSchema = z.object({
  id: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mime: z.string().min(1).max(256),
  bytes: z.number().int().nonnegative(),
  truncated: z.boolean(),
  truncatedBase64Content: z.string().max(16 * 1024),
}).strict();

// ── Write paths ──────────────────────────────────────────────────────────────

/**
 * Args: `[mcpContext, {title, objective, projectId, hostId,
 * baseIdentity?, rootIdentity?}]`. The facade refuses with
 * `FORBIDDEN` when `projectId` is not in `mcpContext.projectIds`
 * — the agent cannot create tasks outside the principal's
 * permitted projects.
 */
export const mcpCreateTaskInputSchema = z.tuple([
  mcpContextSchema,
  z.object({
    title: z.string().trim().min(1).max(200),
    objective: z.string().max(8000).default(""),
    projectId: projectIdSchema,
    hostId: z.string().trim().min(1).max(128),
    providerVersion: z.string().min(1).max(256).nullable().optional(),
    model: z.string().min(1).max(256).nullable().optional(),
    accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable().optional(),
    baseIdentity: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().optional(),
    rootIdentity: z.string().regex(/^\d+:\d+$/).nullable().optional(),
    effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable().optional(),
  }).strict(),
]);

/**
 * Result union. `ok` carries the new task; `forbidden`
 * carries the reason (project not permitted, principal
 * empty, or invalid projectId). The same envelope covers
 * the other write paths.
 */
export const mcpCreateTaskResultSchema = z.union([
  z.object({
    kind: z.literal("ok"),
    task: mcpTaskSummarySchema,
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);

/**
 * Args: `[mcpContext, {runId, reason}]`. Refuses with
 * FORBIDDEN when the run's task project is not in
 * `mcpContext.projectIds`.
 */
export const mcpRequestStopInputSchema = z.tuple([
  mcpContextSchema,
  z.object({
    runId: z.string().uuid(),
    reason: z.string().min(1).max(256),
  }).strict(),
]);

export const mcpRequestStopResultSchema = z.union([
  z.object({
    kind: z.literal("ok"),
    runId: z.string().uuid(),
    status: z.literal("cancelled"),
    blockedExecuteOnce: z.literal(true),
  }).strict(),
  z.object({
    kind: z.literal("forbidden"),
    reason: z.string().min(1).max(1024),
  }).strict(),
  z.object({
    kind: z.literal("not-found"),
    reason: z.string().min(1).max(1024),
  }).strict(),
]);
