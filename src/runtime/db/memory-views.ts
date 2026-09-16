/**
 * M4.6.c — bounded memory views.
 *
 * The runtime stores every task, run, invocation, receipt, artifact,
 * attention item and terminal in a flat ledger. For the renderer to
 * reconstruct a session / terminal / task view, it needs a bounded
 * projection that:
 *  - never loads the full ledger (the meta table grows monotonically),
 *  - applies explicit per-axis caps so a caller cannot request an
 *    unbounded slice,
 *  - produces a digest that covers the bounded payload so a renderer
 *    can detect a content change without re-rendering.
 *
 * Three projections, each with explicit caps:
 *  - `viewSessionMemory` — tasks in a project + runs / invocations /
 *    artifacts / attention per cap.
 *  - `viewTerminalMemory` — terminal row + bounded terminal-history
 *    lines.
 *  - `viewTaskMemory` — single task + runs / invocations / attention /
 *    artifacts per cap.
 *
 * The terminal-history lines are stored in the meta table under
 * `terminal-history:<terminalUuid>:<seq>`. M4.6.c reads them
 * bounded; new lines are appended by future IPC handlers (M5+) via
 * `appendTerminalHistory` (exported for tests / future callers).
 *
 * Caps are clamped to the `MEMORY_VIEW_MAX_*` constants; passing a
 * cap of `0` or negative raises `INVALID_REQUEST` because the user
 * almost certainly did not mean "give me zero rows".
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";
import { latestPromptAnchor, resolvePromptAnchorSettings, type PromptAnchorSettings } from "../orchestration/prompt-anchor";
import type { PromptAnchor } from "../../shared/prompt-anchor-schema";
import { taskRowSchema, runRowSchema, invocationRowSchema, artifactReferenceRowSchema, attentionItemRowSchema, terminalRowSchema } from "./schema";
import { listContextImportsForRun } from "./context-import";
import { listRevisionUpdates } from "./revision-update";

/** Caps — values a caller may pass are clamped to these. */
export const MEMORY_VIEW_MAX_RUNS_PER_TASK = 64;
export const MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN = 64;
export const MEMORY_VIEW_MAX_ATTENTION_ITEMS = 256;
export const MEMORY_VIEW_MAX_ARTIFACTS_PER_RUN = 64;
export const MEMORY_VIEW_MAX_TERMINAL_LINES = 4096;
export const MEMORY_VIEW_MAX_TASKS_PER_SESSION = 64;

/** Meta-key prefix for terminal history lines. */
export const TERMINAL_HISTORY_META_PREFIX = "terminal-history:";

export const terminalHistoryLineSchema = z
  .object({
    terminalUuid: z.string().uuid(),
    seq: z.number().int().min(1).max(1_000_000),
    capturedAt: z.string().datetime(),
    stream: z.enum(["stdout", "stderr", "marker"]),
    content: z.string().max(64 * 1024),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type TerminalHistoryLine = z.infer<typeof terminalHistoryLineSchema>;

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

/**
 * Clamp a caller-supplied cap. `0` or negative raises `INVALID_REQUEST`
 * because the caller almost certainly meant "some rows, please".
 * Above-the-max clamps silently.
 */
function clampCap(raw: number | undefined, max: number, name: string): number {
  if (raw === undefined) return max;
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new AppError("INVALID_REQUEST", `Memory-view cap "${name}" must be a positive integer (got ${raw})`);
  }
  return Math.min(raw, max);
}

/** Compute a digest over a bounded payload. */
function digestBounded(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

export interface MemoryView<T> {
  readonly kind: "session" | "terminal" | "task";
  readonly cap: Readonly<Record<string, number>>;
  readonly data: T;
  readonly digest: string;
}

// --------------------------------------------------------------------
// Session view
// --------------------------------------------------------------------

export interface SessionTaskSlice {
  readonly taskId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly status: string;
    readonly updatedAt: string;
    readonly baseRevision: string | null;
    readonly invocations: ReadonlyArray<{
      readonly invocationId: string;
      readonly status: string;
      readonly attempt: number;
    }>;
    readonly imports: ReadonlyArray<{
      readonly digest: string;
      readonly origin: string;
      readonly importedAt: string;
    }>;
    readonly revisionUpdates: ReadonlyArray<{
      readonly seq: number;
      readonly headRevision: string;
      readonly recordedAt: string;
    }>;
  }>;
  readonly attention: ReadonlyArray<{
    readonly attentionId: string;
    readonly kind: string;
    readonly state: string;
    readonly updatedAt: string;
  }>;
}

export interface SessionMemoryData {
  readonly sessionId: string;
  readonly taskCount: number;
  readonly tasks: ReadonlyArray<SessionTaskSlice>;
}

export async function viewSessionMemory(
  worker: DbWorker,
  input: {
    sessionId: string;
    maxTasks?: number;
    maxRunsPerTask?: number;
    maxInvocationsPerRun?: number;
    maxAttentionItems?: number;
  },
): Promise<MemoryView<SessionMemoryData>> {
  const cap = {
    maxTasks: clampCap(input.maxTasks, MEMORY_VIEW_MAX_TASKS_PER_SESSION, "maxTasks"),
    maxRunsPerTask: clampCap(input.maxRunsPerTask, MEMORY_VIEW_MAX_RUNS_PER_TASK, "maxRunsPerTask"),
    maxInvocationsPerRun: clampCap(input.maxInvocationsPerRun, MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN, "maxInvocationsPerRun"),
    maxAttentionItems: clampCap(input.maxAttentionItems, MEMORY_VIEW_MAX_ATTENTION_ITEMS, "maxAttentionItems"),
  };
  if (input.sessionId.length === 0 || input.sessionId.length > 256) {
    throw new AppError("INVALID_REQUEST", "sessionId must be 1..256 characters");
  }
  const driver = driverOf(worker);
  // Tasks are scoped by `project_id` (the M3a convention; sessions map
  // to projects 1:1 in the M3 shell, with `sessionId == projectId`).
  const allTaskRows = driver.prepare(`SELECT * FROM task WHERE project_id = ? ORDER BY updated_at DESC`).all(input.sessionId);
  const tasks = allTaskRows.slice(0, cap.maxTasks);
  const slices: SessionTaskSlice[] = [];
  for (const taskRow of tasks) {
    const task = parseTaskRow(taskRow);
    const runRows = driver.prepare(`SELECT * FROM run WHERE task_id = ? ORDER BY created_at DESC LIMIT ${cap.maxRunsPerTask}`).all(task.id);
    const runs = runRows.map((r) => {
      const run = parseRunRow(r);
      const invRows = driver.prepare(`SELECT * FROM invocation WHERE run_id = ? ORDER BY created_at ASC LIMIT ${cap.maxInvocationsPerRun}`).all(run.id);
      const invocations = invRows.map((ir) => {
        const inv = parseInvocationRow(ir);
        return {
          invocationId: inv.id,
          status: inv.status,
          attempt: inv.attempt,
        };
      });
      const imports = listContextImportsForRun(worker, run.id).map((ci) => ({
        digest: ci.digest,
        origin: ci.origin,
        importedAt: ci.importedAt,
      }));
      const updates = listRevisionUpdates(worker, run.id).map((u) => ({
        seq: u.seq,
        headRevision: u.headRevision,
        recordedAt: u.recordedAt,
      }));
      return {
        runId: run.id,
        status: run.status,
        updatedAt: run.updatedAt,
        baseRevision: run.baseRevision,
        invocations,
        imports,
        revisionUpdates: updates,
      };
    });
    const attRows = driver.prepare(`SELECT * FROM attention_item WHERE task_id = ? ORDER BY updated_at DESC LIMIT ${cap.maxAttentionItems}`).all(task.id);
    const attention = attRows.map((ar) => {
      const att = parseAttentionRow(ar);
      return {
        attentionId: att.id,
        kind: att.kind,
        state: att.state,
        updatedAt: att.updatedAt,
      };
    });
    slices.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      updatedAt: task.updatedAt,
      runs,
      attention,
    });
  }
  const data: SessionMemoryData = {
    sessionId: input.sessionId,
    taskCount: allTaskRows.length,
    tasks: slices,
  };
  return {
    kind: "session",
    cap,
    data,
    digest: digestBounded(data),
  };
}

// --------------------------------------------------------------------
// Terminal view
// --------------------------------------------------------------------

export interface TerminalMemoryData {
  readonly terminalUuid: string;
  readonly terminal: {
    readonly sessionId: number;
    readonly label: string;
    readonly cwd: string;
    readonly command: string;
    readonly createdAt: string;
    readonly exitCode: number | null;
    readonly exitSignal: string | null;
    readonly startedAt: string | null;
    readonly endedAt: string | null;
    readonly launchError: string | null;
    readonly launchState: string | null;
    readonly envProfileId: string | null;
    readonly originHookId: string | null;
  };
  readonly lines: ReadonlyArray<TerminalHistoryLine>;
  /** M5.7 — latest literal prompt-anchor detected in the bounded window, or `null`. */
  readonly promptAnchor: PromptAnchor | null;
}

export function viewTerminalMemory(
  worker: DbWorker,
  input: { terminalUuid: string; maxLines?: number; promptAnchorSettings?: Partial<PromptAnchorSettings> },
): MemoryView<TerminalMemoryData> {
  if (input.terminalUuid.length === 0 || input.terminalUuid.length > 256) {
    throw new AppError("INVALID_REQUEST", "terminalUuid must be 1..256 characters");
  }
  const cap = {
    maxLines: clampCap(input.maxLines, MEMORY_VIEW_MAX_TERMINAL_LINES, "maxLines"),
  };
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT * FROM terminal WHERE uuid = ?`).first(input.terminalUuid);
  if (!row) {
    throw new AppError("NOT_FOUND", `Terminal ${input.terminalUuid} not found`);
  }
  const terminal = parseTerminalRow(row);
  const lines = listTerminalHistory(worker, input.terminalUuid, cap.maxLines);
  const anchorSettings = resolvePromptAnchorSettings(input.promptAnchorSettings ?? {});
  const promptAnchor = latestPromptAnchor(input.terminalUuid, lines, anchorSettings);
  const data: TerminalMemoryData = {
    terminalUuid: input.terminalUuid,
    terminal: {
      sessionId: terminal.session_id,
      label: terminal.label,
      cwd: terminal.cwd,
      command: terminal.command,
      createdAt: terminal.created_at,
      exitCode: terminal.exit_code,
      exitSignal: terminal.exit_signal,
      startedAt: terminal.started_at,
      endedAt: terminal.ended_at,
      launchError: terminal.launch_error,
      launchState: terminal.launch_state,
      envProfileId: terminal.env_profile_id,
      originHookId: terminal.origin_hook_id,
    },
    lines,
    promptAnchor,
  };
  return {
    kind: "terminal",
    cap,
    data,
    digest: digestBounded(data),
  };
}

// --------------------------------------------------------------------
// Task view
// --------------------------------------------------------------------

export interface TaskMemoryData {
  readonly taskId: string;
  readonly task: {
    readonly title: string;
    readonly status: string;
    readonly objective: string;
    readonly projectId: string;
    readonly updatedAt: string;
  };
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly status: string;
    readonly updatedAt: string;
    readonly baseRevision: string | null;
    readonly invocations: ReadonlyArray<{
      readonly invocationId: string;
      readonly status: string;
      readonly attempt: number;
    }>;
    readonly imports: ReadonlyArray<{
      readonly digest: string;
      readonly origin: string;
      readonly importedAt: string;
    }>;
    readonly revisionUpdates: ReadonlyArray<{
      readonly seq: number;
      readonly headRevision: string;
      readonly recordedAt: string;
    }>;
    readonly artifacts: ReadonlyArray<{
      readonly artifactId: string;
      readonly uri: string;
      readonly sha256: string;
      readonly kind: string;
    }>;
  }>;
  readonly attention: ReadonlyArray<{
    readonly attentionId: string;
    readonly kind: string;
    readonly state: string;
    readonly updatedAt: string;
  }>;
}

export async function viewTaskMemory(
  worker: DbWorker,
  input: {
    taskId: string;
    maxRuns?: number;
    maxInvocationsPerRun?: number;
    maxAttentionItems?: number;
    maxArtifacts?: number;
  },
): Promise<MemoryView<TaskMemoryData>> {
  const cap = {
    maxRuns: clampCap(input.maxRuns, MEMORY_VIEW_MAX_RUNS_PER_TASK, "maxRuns"),
    maxInvocationsPerRun: clampCap(input.maxInvocationsPerRun, MEMORY_VIEW_MAX_INVOCATIONS_PER_RUN, "maxInvocationsPerRun"),
    maxAttentionItems: clampCap(input.maxAttentionItems, MEMORY_VIEW_MAX_ATTENTION_ITEMS, "maxAttentionItems"),
    maxArtifacts: clampCap(input.maxArtifacts, MEMORY_VIEW_MAX_ARTIFACTS_PER_RUN, "maxArtifacts"),
  };
  if (input.taskId.length === 0 || input.taskId.length > 256) {
    throw new AppError("INVALID_REQUEST", "taskId must be 1..256 characters");
  }
  const driver = driverOf(worker);
  const taskRow = driver.prepare(`SELECT * FROM task WHERE uuid = ?`).first(input.taskId);
  if (!taskRow) throw new AppError("NOT_FOUND", `Task ${input.taskId} not found`);
  const task = parseTaskRow(taskRow);
  const runRows = driver.prepare(`SELECT * FROM run WHERE task_id = ? ORDER BY created_at DESC LIMIT ${cap.maxRuns}`).all(input.taskId);
  const runs = runRows.map((r) => {
    const run = parseRunRow(r);
    const invRows = driver.prepare(`SELECT * FROM invocation WHERE run_id = ? ORDER BY created_at ASC LIMIT ${cap.maxInvocationsPerRun}`).all(run.id);
    const invocations = invRows.map((ir) => {
      const inv = parseInvocationRow(ir);
      return { invocationId: inv.id, status: inv.status, attempt: inv.attempt };
    });
    const imports = listContextImportsForRun(worker, run.id).map((ci) => ({
      digest: ci.digest, origin: ci.origin, importedAt: ci.importedAt,
    }));
    const updates = listRevisionUpdates(worker, run.id).map((u) => ({
      seq: u.seq, headRevision: u.headRevision, recordedAt: u.recordedAt,
    }));
    const artRows = driver.prepare(`SELECT * FROM artifact_reference WHERE run_id = ? ORDER BY imported_at ASC LIMIT ${cap.maxArtifacts}`).all(run.id);
    const artifacts = artRows.map((ar) => {
      const a = parseArtifactRow(ar);
      return { artifactId: a.id, uri: a.uri, sha256: a.sha256, kind: a.kind };
    });
    return {
      runId: run.id, status: run.status, updatedAt: run.updatedAt, baseRevision: run.baseRevision,
      invocations, imports, revisionUpdates: updates, artifacts,
    };
  });
  const attRows = driver.prepare(`SELECT * FROM attention_item WHERE task_id = ? ORDER BY updated_at DESC LIMIT ${cap.maxAttentionItems}`).all(input.taskId);
  const attention = attRows.map((ar) => {
    const att = parseAttentionRow(ar);
    return { attentionId: att.id, kind: att.kind, state: att.state, updatedAt: att.updatedAt };
  });
  const data: TaskMemoryData = {
    taskId: input.taskId,
    task: {
      title: task.title,
      status: task.status,
      objective: task.objective,
      projectId: task.projectId,
      updatedAt: task.updatedAt,
    },
    runs,
    attention,
  };
  return { kind: "task", cap, data, digest: digestBounded(data) };
}

// --------------------------------------------------------------------
// Terminal-history writer (M4.6.c seam for future IPC)
// --------------------------------------------------------------------

const appendLineInputSchema = z
  .object({
    terminalUuid: z.string().uuid(),
    stream: z.enum(["stdout", "stderr", "marker"]),
    content: z.string().min(0).max(64 * 1024),
  })
  .strict();

/**
 * Append a terminal-history line. The `seq` is the count of existing
 * meta rows for this terminal + 1 so a write-collision is impossible.
 *
 * Used by future IPC handlers (M5+). Exported here so tests can
 * populate a terminal's history without coupling to the IPC layer.
 */
export async function appendTerminalHistory(
  worker: DbWorker,
  input: z.input<typeof appendLineInputSchema>,
): Promise<TerminalHistoryLine> {
  const parsed = appendLineInputSchema.parse(input);
  const driver = driverOf(worker);
  const terminalExists = driver.prepare(`SELECT uuid FROM terminal WHERE uuid = ?`).first(parsed.terminalUuid);
  if (!terminalExists) throw new AppError("NOT_FOUND", `Terminal ${parsed.terminalUuid} not found`);
  const capturedAt = new Date().toISOString();
  const existing = listTerminalHistoryInner(driver, parsed.terminalUuid, Number.POSITIVE_INFINITY);
  const seq = existing.length + 1;
  const canonical = {
    terminalUuid: parsed.terminalUuid,
    seq,
    capturedAt,
    stream: parsed.stream,
    content: parsed.content,
  };
  const payloadDigest = createHash("sha256")
    .update(stableStringify({ ...canonical, payloadDigest: "" }), "utf8")
    .digest("hex");
  const line: TerminalHistoryLine = terminalHistoryLineSchema.parse({ ...canonical, payloadDigest });
  driver
    .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(historyKey(parsed.terminalUuid, seq), JSON.stringify(line));
  return line;
}

/** Test seam: list terminal-history lines for a terminal, ascending by `seq`, capped. */
export function listTerminalHistory(worker: DbWorker, terminalUuid: string, maxLines: number): TerminalHistoryLine[] {
  return listTerminalHistoryInner(driverOf(worker), terminalUuid, maxLines);
}

function listTerminalHistoryInner(driver: DriverRaw, terminalUuid: string, maxLines: number): TerminalHistoryLine[] {
  const prefix = `${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:`;
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const out: TerminalHistoryLine[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(prefix)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      out.push(terminalHistoryLineSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip malformed rows silently.
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  if (out.length > maxLines) return out.slice(out.length - maxLines);
  return out;
}

/** Test seam: build the meta key for a terminal-history line. */
export function historyKey(terminalUuid: string, seq: number): string {
  return `${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:${seq}`;
}

// --------------------------------------------------------------------
// Parsers
// --------------------------------------------------------------------

function parseTaskRow(row: Record<string, unknown>) {
  return taskRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    title: String(row.title ?? ""),
    objective: String(row.objective ?? ""),
    status: String(row.status),
    projectId: String(row.project_id ?? ""),
    providerVersion: row.provider_version == null ? null : String(row.provider_version),
    model: row.model == null ? null : String(row.model),
    accountMode: row.account_mode == null ? null : String(row.account_mode),
    hostId: String(row.host_id ?? ""),
    baseIdentity: row.base_identity == null ? null : String(row.base_identity),
    rootIdentity: row.root_identity == null ? null : String(row.root_identity),
    effectiveInputs: row.effective_inputs_json == null ? null : JSON.parse(String(row.effective_inputs_json)),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function parseRunRow(row: Record<string, unknown>) {
  return runRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: String(row.task_id),
    status: String(row.status),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    baseRevision: row.base_revision == null ? null : String(row.base_revision),
    terminalUuid: row.terminal_uuid == null ? null : String(row.terminal_uuid),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function parseInvocationRow(row: Record<string, unknown>) {
  return invocationRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    runId: String(row.run_id),
    attempt: Number(row.attempt ?? 1),
    status: String(row.status),
    idempotencyKey: String(row.idempotency_key),
    canonicalDigest: String(row.canonical_digest),
    providerVersion: String(row.provider_version ?? ""),
    model: String(row.model ?? ""),
    accountMode: String(row.account_mode ?? "anonymous"),
    startedAt: row.started_at == null ? null : String(row.started_at),
    endedAt: row.ended_at == null ? null : String(row.ended_at),
    endedReason: row.ended_reason == null ? null : String(row.ended_reason),
    createdAt: String(row.created_at),
  });
}

function parseAttentionRow(row: Record<string, unknown>) {
  return attentionItemRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    kind: String(row.kind),
    issueIdentity: String(row.issue_identity),
    revision: Number(row.revision ?? 0),
    state: String(row.state),
    payloadJson: String(row.payload_json ?? "{}"),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    snoozedUntil: row.snoozed_until == null ? null : String(row.snoozed_until),
  });
}

function parseArtifactRow(row: Record<string, unknown>) {
  return artifactReferenceRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    uri: String(row.uri),
    sha256: String(row.sha256),
    kind: String(row.kind),
    bytes: Number(row.bytes ?? 0),
    mime: String(row.mime ?? ""),
    importedAt: String(row.imported_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
  });
}

function parseTerminalRow(row: Record<string, unknown>) {
  return terminalRowSchema.parse({
    uuid: String(row.uuid),
    session_id: Number(row.session_id),
    label: String(row.label ?? ""),
    cwd: String(row.cwd ?? ""),
    command: String(row.command ?? ""),
    created_at: String(row.created_at),
    deleting: Number(row.deleting) === 1 ? 1 : 0,
    deletion_policy: row.deletion_policy == null ? null : String(row.deletion_policy),
    launch_error: row.launch_error == null ? null : String(row.launch_error),
    started_at: row.started_at == null ? null : String(row.started_at),
    ended_at: row.ended_at == null ? null : String(row.ended_at),
    exit_signal: row.exit_signal == null ? null : String(row.exit_signal),
    exit_code: row.exit_code == null ? null : Number(row.exit_code),
    metadata_json: row.metadata_json == null ? null : String(row.metadata_json),
    env_json: row.env_json == null ? null : String(row.env_json),
    env_profile_id: row.env_profile_id == null ? null : String(row.env_profile_id),
    prompt_anchors_json: row.prompt_anchors_json == null ? null : String(row.prompt_anchors_json),
    launch_state: row.launch_state == null ? null : String(row.launch_state),
    origin_hook_id: row.origin_hook_id == null ? null : String(row.origin_hook_id),
  });
}
