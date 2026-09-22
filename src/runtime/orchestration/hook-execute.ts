/**
 * M4.7.b/c — runtime hook execution seam.
 *
 * The orchestrator is the runtime's *only* path for firing a
 * hook in response to a domain event. It enforces:
 *
 *  - **Activation gate.** Only hooks with an activation row
 *    (see `runtime/db/hook-activation.ts`) are eligible.
 *  - **Scoped inherited authority.** A hook firing inside a
 *    managed context (`taskId` supplied) inherits the
 *    **narrowed** authority of the task's `approved`
 *    `authority` grants — never the renderer's broader
 *    authority. A hook without inherited authority for its
 *    `action.type` is refused with `FORBIDDEN`. A hook firing
 *    outside a managed context inherits no authority; only
 *    `notify` is allowed without authority, and `open-file`
 *    requires an `approved` grant covering the action.
 *  - **Deadlines.** A hook runs under `HOOK_DEADLINE_MS`
 *    (default 5_000). Exceeding the deadline aborts the hook
 *    with `outcome: "timeout"` and aborts the underlying
 *    child process via `AbortController`.
 *  - **Output limits.** Captured stdout/stderr are bounded by
 *    `HOOK_OUTPUT_MAX_BYTES` (default 64 KiB). Exceeding the
 *    cap aborts with `outcome: "output-cap"`.
 *  - **Recursion bounds.** A hook that fires another hook past
 *    `HOOK_MAX_RECURSION_DEPTH = 4` is refused with
 *    `outcome: "recursion"`.
 *  - **Inflight cap.** A hook beyond `HOOK_MAX_INFLIGHT = 32`
 *    is refused with `outcome: "throttled"`.
 *  - **Failure policy.** Every abort records a `hook.failed`
 *    audit event with the canonical failure code and a
 *    single `attention_item(kind: "hook-failure")` row so the
 *    M3c.3 inbox surfaces it. No retries.
 *
 * Renderer notify / open-file triggers and native provider
 * hooks retain separate semantics: this module exposes the
 * **runtime** hook plane only.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { z } from "zod";
import { AppError, type Failure } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import type { DbWorker } from "../db/worker";
import { hookSchema } from "../../shared/hooks";
import {
  isHookActive,
  listActiveHookIds,
  type HookActionKind,
} from "../db/hook-activation";
import { listGrants } from "../db/grants";
import { raiseAttention } from "../db/attention-items";

/** Caps — caller-supplied values are clamped to these. */
export const HOOK_DEADLINE_MS = 5000;
export const HOOK_OUTPUT_MAX_BYTES = 65536;
export const HOOK_MAX_RECURSION_DEPTH = 4;
export const HOOK_MAX_INFLIGHT = 32;
export const HOOK_ACTION_OUTPUT_LINE_MAX = 1024;

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

/** Hook execution outcome — the orchestrator's structured refusal vocabulary. */
export type HookExecutionOutcome =
  | "fired"
  | "forbidden"
  | "timeout"
  | "output-cap"
  | "recursion"
  | "exit-error"
  | "inactive"
  | "throttled";

export interface HookExecutionResult {
  readonly hookId: string;
  readonly eventSeq: number;
  readonly outcome: HookExecutionOutcome;
  readonly observedAt: string;
  readonly outputBytes: number;
  readonly payloadDigest: string;
  readonly failureCode?: Failure["code"];
  readonly failureMessage?: string;
  readonly eventSeqAudit?: number;
}

export interface HookExecutionInput {
  readonly hookId: string;
  readonly eventType: string;
  readonly eventSeq: number;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly terminalId: string | null;
  readonly payload: unknown;
  readonly principal: string;
  deadlineMs?: number;
  outputByteCap?: number;
}

const hookExecutionInputSchema = z
  .object({
    hookId: z.string().uuid(),
    eventType: z.string().min(1).max(64),
    eventSeq: z.number().int().nonnegative(),
    runId: z.string().uuid().nullable(),
    taskId: z.string().uuid().nullable(),
    sessionId: z.string().uuid().nullable(),
    terminalId: z.string().uuid().nullable(),
    payload: z.unknown(),
    principal: z.string().min(1).max(256),
    deadlineMs: z.number().int().optional(),
    outputByteCap: z.number().int().optional(),
  })
  .strict();

interface ClampOpts { value: number | undefined; max: number; name: string }
function clampCap({ value, max, name }: ClampOpts): number {
  if (value === undefined) return max;
  if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value))
    throw new AppError("INVALID_REQUEST",
      `Hook cap "${name}" must be a positive integer (got ${value})`);
  return Math.min(value, max);
}

/** Process-global inflight counter. */
let inflight = 0;

/** Test seam: query the inflight counter. */
export function hookInflight(): number { return inflight; }
/** Test seam: reset the inflight counter. */
export function resetHookInflight(): void { inflight = 0; }

/**
 * Process-global recursion depth keyed by the (eventType,
 * eventSeq) tuple. A single event can fan out to multiple
 * hooks, but each hook sees the same depth; a hook that
 * triggers another event starts a fresh depth-1 entry.
 */
const recursionDepths = new Map<string, number>();

function recursionKey(eventType: string, eventSeq: number): string {
  return `${eventType}:${eventSeq}`;
}

/** Test seam: reset the recursion-depth table. */
export function resetHookRecursion(): void { recursionDepths.clear(); }

/**
 * List all hook rows whose identity matches the supplied
 * eventType + sessionId + terminalId, intersected with the
 * activation gate.
 */
async function listMatchingHookRows(
  worker: DbWorker,
  eventType: string,
  sessionId: string | null,
  terminalId: string | null,
): Promise<Array<{ uuid: string; name: string; session_uuid: string | null; terminal_uuid: string | null; match: string | null; event: string }>> {
  const driver = driverOf(worker);
  const activeIds = await listActiveHookIds(worker);
  if (activeIds.length === 0) return [];
  const rows = driver.prepare(
    "SELECT uuid, name, event, session_uuid, terminal_uuid, match FROM hook " +
    "WHERE event = ?",
  ).all(eventType);
  return rows
    .map((row) => ({
      uuid: String(row.uuid),
      name: String(row.name),
      session_uuid: row.session_uuid == null ? null : String(row.session_uuid),
      terminal_uuid: row.terminal_uuid == null ? null : String(row.terminal_uuid),
      match: row.match == null ? null : String(row.match),
      event: String(row.event),
    }))
    .filter((row) => activeIds.includes(row.uuid))
    .filter((row) => {
      // The hook row's session / terminal filter must match
      // (or be null = "any"). The match-string field is a
      // renderer-side pattern; the orchestrator only enforces
      // exact equality on session/terminal ids.
      if (row.session_uuid !== null && row.session_uuid !== (sessionId ?? "")) return false;
      if (row.terminal_uuid !== null && row.terminal_uuid !== (terminalId ?? "")) return false;
      return true;
    });
}

/**
 * Compute the next event seq using the in-memory driver's
 * `ORDER BY seq DESC LIMIT 1` pattern (it doesn't support
 * `MAX(seq)+1`).
 */
async function nextEventSeq(worker: DbWorker): Promise<number> {
  const driver = driverOf(worker);
  const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
  return maxRow && maxRow.seq != null ? Number(maxRow.seq) + 1 : 1;
}
void nextEventSeq;

async function writeAuditEvent(
  worker: DbWorker,
  args: {
    at: string;
    correlationId: string;
    sessionId: string | null;
    terminalId: string | null;
    originHookId: string | null;
    type: string;
    payload: unknown;
  },
): Promise<number> {
  const driver = driverOf(worker);
  let seq = -1;
  await worker.transaction(tx => {
    void tx;
    seq = -1;
    const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
    const max = maxRow && maxRow.seq != null ? Number(maxRow.seq) : 0;
    seq = max + 1;
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, " +
      "origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      seq, args.at, args.correlationId, "runtime-hook",
      args.sessionId, args.terminalId, args.originHookId,
      args.type, JSON.stringify(args.payload),
    );
  });
  return seq;
}

function digestPayload(payload: unknown): string {
  return createHash("sha256")
    .update(stableStringify(payload), "utf8")
    .digest("hex");
}

interface ResolvedAuthority {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Resolve inherited authority for a hook action. Returns
 * `{allowed: true}` iff an `approved` `authority` grant
 * covers the hook's `action.type`. Outside a managed
 * context, only `notify` is allowed without a grant;
 * `open-file` requires an `approved` grant whose
 * `scope_json.hookKinds` includes `"open-file"`.
 */
async function resolveAuthority(
  worker: DbWorker,
  _hookId: string,
  hookKind: HookActionKind,
  taskId: string | null,
  hookPath: string | null,
): Promise<ResolvedAuthority> {
  // Outside a managed context: only `notify` is allowed.
  if (taskId === null) {
    if (hookKind === "notify") return { allowed: true };
    return { allowed: false, reason: "Hook fires outside a managed context; authority is required" };
  }
  const grants = await listGrants(worker, { state: "approved", taskId });
  const authorityGrants = grants.filter((g) => g.kind === "authority");
  if (authorityGrants.length === 0) {
    return { allowed: false, reason: `Task ${taskId} has no approved authority grant` };
  }
  // Intersect hookKinds across grants: the hook is allowed
  // only if every approved authority grant covers it.
  for (const grant of authorityGrants) {
    let scope: { hookKinds?: unknown; paths?: unknown } = {};
    try {
      const parsed = JSON.parse(grant.scopeJson) as { hookKinds?: unknown; paths?: unknown };
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        scope = parsed;
    } catch {
      scope = {};
    }
    const kinds = scope.hookKinds;
    if (!Array.isArray(kinds) || !kinds.includes(hookKind)) {
      return { allowed: false,
        reason: `Grant ${grant.id} scope_json.hookKinds does not include "${hookKind}"` };
    }
    if (hookKind === "open-file" && hookPath !== null) {
      const allowedPaths = scope.paths;
      // An absent or empty `paths` list means unrestricted —
      // any path the renderer-supplied refinement accepts is OK.
      if (Array.isArray(allowedPaths) && allowedPaths.length > 0) {
        if (!allowedPaths.includes(hookPath))
          return { allowed: false,
            reason: `Grant ${grant.id} scope_json.paths does not include "${hookPath}"` };
      }
    }
  }
  return { allowed: true };
}

/** Parse the hook's action payload from a row read. */
function readHookAction(worker: DbWorker, hookId: string): Promise<{
  hookKind: HookActionKind;
  notifyMessage: string | null;
  command: string | null;
  openPath: string | null;
} | undefined> {
  return (async () => {
    const driver = driverOf(worker);
    const row = driver
      .prepare("SELECT action_json FROM hook WHERE uuid = ?")
      .first(hookId);
    if (!row) return undefined;
    let action: unknown;
    try {
      action = JSON.parse(String(row.action_json ?? "{}"));
    } catch {
      return undefined;
    }
    const parsed = hookSchema.shape.action.safeParse(action);
    if (!parsed.success) return undefined;
    const data = parsed.data;
    const actionObj = data as { type: string; message?: string; command?: string; path?: string };
    if (actionObj.type === "notify") {
      return {
        hookKind: "notify",
        notifyMessage: actionObj.message ?? null,
        command: null,
        openPath: null,
      };
    }
    if (actionObj.type === "run-command-in-terminal") {
      return {
        hookKind: "run-command-in-terminal",
        notifyMessage: null,
        command: actionObj.command ?? null,
        openPath: null,
      };
    }
    if (actionObj.type === "open-file") {
      return {
        hookKind: "open-file",
        notifyMessage: null,
        command: null,
        openPath: actionObj.path ?? null,
      };
    }
    return undefined;
  })();
}

/**
 * Bounded subprocess helper for `run-command-in-terminal`
 * hooks. Returns `{outputBytes, exitCode, signal, timedOut,
 * outputExceeded}`. The child process is killed when the
 * abort signal fires.
 */
async function runBoundedChild(
  command: string,
  deadlineMs: number,
  outputByteCap: number,
): Promise<{
  outputBytes: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  outputExceeded: boolean;
}> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  let outputExceeded = false;
  let outputBytes = 0;

  const child = spawn(command, [], {
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
  });
  // Promise resolves on close; rejects on spawn error.
  const close: Promise<{ code: number | null; signal: NodeJS.Signals | null }> = new Promise((resolve, reject) => {
    let bufBytes = 0;
    const onChunk = (chunk: Buffer) => {
      bufBytes += chunk.byteLength;
      if (bufBytes > outputByteCap) {
        outputExceeded = true;
        if (!controller.signal.aborted) controller.abort();
      }
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.on("data", onChunk);
    child.on("close", (code, signal) => {
      outputBytes = bufBytes;
      resolve({ code, signal });
    });
    child.on("error", (error) => {
      if (controller.signal.aborted) resolve({ code: null, signal: null });
      else reject(error);
    });
  });

  const timeout = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(() => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, deadlineMs);
  });

  const result = await Promise.race([close, timeout]);
  if (timer !== null) clearTimeout(timer);
  if (timedOut || outputExceeded) {
    // Best-effort wait for the close event after abort; if the
    // close promise has already settled we use that result.
    if (!controller.signal.aborted) controller.abort();
    try { await close; } catch { /* ignore post-abort errors */ }
  }
  return {
    outputBytes,
    exitCode: result.code,
    signal: result.signal,
    timedOut,
    outputExceeded,
  };
}

/**
 * Execute a single hook. Returns the structured
 * `HookExecutionResult`; never throws on hook-policy
 * violations (those are encoded as outcomes). Throws
 * `AppError("INVALID_REQUEST")` for caller-side errors.
 */
export async function executeHook(
  worker: DbWorker,
  input: HookExecutionInput,
): Promise<HookExecutionResult> {
  let parsed: z.infer<typeof hookExecutionInputSchema>;
  try {
    parsed = hookExecutionInputSchema.parse(input);
  } catch (error) {
    throw new AppError("INVALID_REQUEST",
      error instanceof z.ZodError ? error.message : String(error));
  }
  const deadlineMs = clampCap({ value: parsed.deadlineMs, max: HOOK_DEADLINE_MS, name: "deadlineMs" });
  const outputByteCap = clampCap({ value: parsed.outputByteCap, max: HOOK_OUTPUT_MAX_BYTES, name: "outputByteCap" });

  // Activation gate.
  const active = await isHookActive(worker, parsed.hookId);
  if (!active) {
    return {
      hookId: parsed.hookId,
      eventSeq: parsed.eventSeq,
      outcome: "inactive",
      observedAt: new Date().toISOString(),
      outputBytes: 0,
      payloadDigest: "",
    };
  }

  // Recursion bound.
  const rKey = recursionKey(parsed.eventType, parsed.eventSeq);
  const priorDepth = recursionDepths.get(rKey) ?? 0;
  if (priorDepth >= HOOK_MAX_RECURSION_DEPTH) {
    return {
      hookId: parsed.hookId,
      eventSeq: parsed.eventSeq,
      outcome: "recursion",
      observedAt: new Date().toISOString(),
      outputBytes: 0,
      payloadDigest: "",
      failureCode: "INTERNAL",
      failureMessage: `Recursion depth ${priorDepth} reached the bound (${HOOK_MAX_RECURSION_DEPTH})`,
    };
  }
  recursionDepths.set(rKey, priorDepth + 1);

  // Inflight cap.
  if (inflight >= HOOK_MAX_INFLIGHT) {
    recursionDepths.set(rKey, priorDepth);
    return {
      hookId: parsed.hookId,
      eventSeq: parsed.eventSeq,
      outcome: "throttled",
      observedAt: new Date().toISOString(),
      outputBytes: 0,
      payloadDigest: "",
      failureCode: "BUSY",
      failureMessage: `Inflight cap ${HOOK_MAX_INFLIGHT} reached`,
    };
  }
  inflight++;

  try {
    const action = await readHookAction(worker, parsed.hookId);
    if (!action) {
      return {
        hookId: parsed.hookId,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden",
        observedAt: new Date().toISOString(),
        outputBytes: 0,
        payloadDigest: "",
        failureCode: "FORBIDDEN",
        failureMessage: "Hook row missing or action payload malformed",
      };
    }

    // Inherited authority gate.
    const authority = await resolveAuthority(
      worker,
      parsed.hookId,
      action.hookKind,
      parsed.taskId,
      action.openPath,
    );
    if (!authority.allowed) {
      const observedAt = new Date().toISOString();
      const payload = {
        hookId: parsed.hookId,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden" as const,
        reason: authority.reason ?? "Authority refused",
        payloadDigest: "",
      };
      const auditSeq = await writeAuditEvent(worker, {
        at: observedAt,
        correlationId: parsed.hookId,
        sessionId: parsed.sessionId,
        terminalId: parsed.terminalId,
        originHookId: parsed.hookId,
        type: "hook.failed",
        payload: { ...payload, payloadDigest: digestPayload(payload) },
      });
      await raiseAttention(worker, {
        taskId: parsed.taskId,
        kind: "hook-failure",
        issueIdentity: `hook:${parsed.hookId}`,
        revision: parsed.eventSeq,
        payload: { outcome: "forbidden", reason: authority.reason, eventType: parsed.eventType, eventSeq: parsed.eventSeq },
      }).catch(() => { /* attention dedupe may surface CONFLICT; swallow */ });
      const result = {
        hookId: parsed.hookId,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden" as const,
        observedAt,
        outputBytes: 0,
        payloadDigest: digestPayload(payload),
        failureCode: "FORBIDDEN" as Failure["code"],
        failureMessage: authority.reason ?? "Authority refused",
        eventSeqAudit: auditSeq,
      };
      return result;
    }
    void authority;

    // Dispatch by action kind.
    const observedAt = new Date().toISOString();
    if (action.hookKind === "notify") {
      const message = action.notifyMessage ?? "";
      const driver = driverOf(worker);
      const metaKey = `notify:${parsed.eventSeq}:${parsed.hookId}`;
      const notifyRecord = {
        message,
        principal: parsed.principal,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        firedAt: observedAt,
      };
      await worker.transaction(tx => {
        void tx;
        driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
          .run(metaKey, JSON.stringify(notifyRecord));
      });
      const payload = {
        hookId: parsed.hookId,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        outcome: "fired" as const,
        firedAt: observedAt,
      };
      const auditSeq = await writeAuditEvent(worker, {
        at: observedAt,
        correlationId: parsed.hookId,
        sessionId: parsed.sessionId,
        terminalId: parsed.terminalId,
        originHookId: parsed.hookId,
        type: "hook-fired",
        payload: { ...payload, payloadDigest: digestPayload(payload) },
      });
      return {
        hookId: parsed.hookId,
        eventSeq: parsed.eventSeq,
        outcome: "fired",
        observedAt,
        outputBytes: Buffer.byteLength(message, "utf8"),
        payloadDigest: digestPayload(payload),
        eventSeqAudit: auditSeq,
      };
    }

    if (action.hookKind === "run-command-in-terminal") {
      if (action.command === null) {
        const payload = {
          hookId: parsed.hookId,
          eventType: parsed.eventType,
          eventSeq: parsed.eventSeq,
          outcome: "exit-error" as const,
          reason: "Hook command payload missing",
          payloadDigest: "",
        };
        const auditSeq = await writeAuditEvent(worker, {
          at: observedAt,
          correlationId: parsed.hookId,
          sessionId: parsed.sessionId,
          terminalId: parsed.terminalId,
          originHookId: parsed.hookId,
          type: "hook.failed",
          payload: { ...payload, payloadDigest: digestPayload(payload) },
        });
        return {
          hookId: parsed.hookId,
          eventSeq: parsed.eventSeq,
          outcome: "exit-error",
          observedAt,
          outputBytes: 0,
          payloadDigest: digestPayload(payload),
          failureCode: "INVALID_REQUEST",
          failureMessage: "Hook command payload missing",
          eventSeqAudit: auditSeq,
        };
      }
      const childResult = await runBoundedChild(action.command, deadlineMs, outputByteCap);
      let outcome: HookExecutionOutcome = "fired";
      let failureCode: Failure["code"] | undefined;
      let failureMessage: string | undefined;
      if (childResult.timedOut) {
        outcome = "timeout";
        failureCode = "TIMEOUT";
        failureMessage = `Hook exceeded deadline ${deadlineMs}ms`;
      } else if (childResult.outputExceeded) {
        outcome = "output-cap";
        failureCode = "UNAVAILABLE";
        failureMessage = `Hook output exceeded ${outputByteCap} bytes`;
      } else if (childResult.exitCode !== 0) {
        outcome = "exit-error";
        failureCode = "INTERNAL";
        failureMessage = `Hook exited with code ${childResult.exitCode}`;
      }
      const payload = {
        hookId: parsed.hookId,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        outcome,
        exitCode: childResult.exitCode,
        signal: childResult.signal,
        outputBytes: childResult.outputBytes,
        payloadDigest: "",
      };
      const auditSeq = await writeAuditEvent(worker, {
        at: observedAt,
        correlationId: parsed.hookId,
        sessionId: parsed.sessionId,
        terminalId: parsed.terminalId,
        originHookId: parsed.hookId,
        type: outcome === "fired" ? "hook-fired" : "hook.failed",
        payload: { ...payload, payloadDigest: digestPayload(payload) },
      });
      if (outcome !== "fired") {
        await raiseAttention(worker, {
          taskId: parsed.taskId,
          kind: "hook-failure",
          issueIdentity: `hook:${parsed.hookId}`,
          revision: parsed.eventSeq,
          payload: { outcome, reason: failureMessage, eventType: parsed.eventType, eventSeq: parsed.eventSeq },
        }).catch(() => { /* swallow dedupe */ });
      }
      return {
        hookId: parsed.hookId,
        eventSeq: parsed.eventSeq,
        outcome,
        observedAt,
        outputBytes: childResult.outputBytes,
        payloadDigest: digestPayload(payload),
        failureCode,
        failureMessage,
        eventSeqAudit: auditSeq,
      };
    }

    // open-file
    if (action.openPath === null) {
      const payload = {
        hookId: parsed.hookId,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden" as const,
        reason: "Hook path payload missing",
        payloadDigest: "",
      };
      const auditSeq = await writeAuditEvent(worker, {
        at: observedAt,
        correlationId: parsed.hookId,
        sessionId: parsed.sessionId,
        terminalId: parsed.terminalId,
        originHookId: parsed.hookId,
        type: "hook.failed",
        payload: { ...payload, payloadDigest: digestPayload(payload) },
      });
      return {
        hookId: parsed.hookId,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden",
        observedAt,
        outputBytes: 0,
        payloadDigest: digestPayload(payload),
        failureCode: "INVALID_REQUEST",
        failureMessage: "Hook path payload missing",
        eventSeqAudit: auditSeq,
      };
    }
    const driver = driverOf(worker);
    const metaKey = `open-file:${parsed.eventSeq}:${parsed.hookId}`;
    const openFileRecord = {
      path: action.openPath,
      principal: parsed.principal,
      eventType: parsed.eventType,
      eventSeq: parsed.eventSeq,
      firedAt: observedAt,
    };
    await worker.transaction(tx => {
      void tx;
      driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
        .run(metaKey, JSON.stringify(openFileRecord));
    });
    const payload = {
      hookId: parsed.hookId,
      eventType: parsed.eventType,
      eventSeq: parsed.eventSeq,
      outcome: "fired" as const,
      path: action.openPath,
      firedAt: observedAt,
    };
    const auditSeq = await writeAuditEvent(worker, {
      at: observedAt,
      correlationId: parsed.hookId,
      sessionId: parsed.sessionId,
      terminalId: parsed.terminalId,
      originHookId: parsed.hookId,
      type: "hook-fired",
      payload: { ...payload, payloadDigest: digestPayload(payload) },
    });
    return {
      hookId: parsed.hookId,
      eventSeq: parsed.eventSeq,
      outcome: "fired",
      observedAt,
      outputBytes: Buffer.byteLength(action.openPath, "utf8"),
      payloadDigest: digestPayload(payload),
      eventSeqAudit: auditSeq,
    };
  } finally {
    inflight--;
    recursionDepths.set(rKey, priorDepth);
  }
}

export interface FireHookInput {
  readonly eventType: string;
  readonly eventSeq: number;
  readonly payload: unknown;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly terminalId: string | null;
  readonly principal: string;
}

export interface FireHookOutcome {
  readonly fired: number;
  readonly refused: number;
  readonly outcomes: ReadonlyArray<HookExecutionResult>;
}

const fireHookInputSchema = z
  .object({
    eventType: z.string().min(1).max(64),
    eventSeq: z.number().int().nonnegative(),
    payload: z.unknown(),
    runId: z.string().uuid().nullable(),
    taskId: z.string().uuid().nullable(),
    sessionId: z.string().uuid().nullable(),
    terminalId: z.string().uuid().nullable(),
    principal: z.string().min(1).max(256),
  })
  .strict();

/**
 * Dispatch all activated hooks whose identity matches the
 * supplied event. Runs sequentially so the process-global
 * recursion / inflight bounds are shared across hooks
 * attached to the same event. Wraps each hook in a
 * try/catch so one misbehaving hook cannot poison the
 * dispatcher's audit stream.
 */
export async function fireHookForEvent(
  worker: DbWorker,
  input: FireHookInput,
): Promise<FireHookOutcome> {
  let parsed: z.infer<typeof fireHookInputSchema>;
  try {
    parsed = fireHookInputSchema.parse(input);
  } catch (error) {
    throw new AppError("INVALID_REQUEST",
      error instanceof z.ZodError ? error.message : String(error));
  }
  const matching = await listMatchingHookRows(
    worker,
    parsed.eventType,
    parsed.sessionId,
    parsed.terminalId,
  );
  const outcomes: HookExecutionResult[] = [];
  let fired = 0;
  let refused = 0;
  for (const row of matching) {
    let result: HookExecutionResult;
    try {
      result = await executeHook(worker, {
        hookId: row.uuid,
        eventType: parsed.eventType,
        eventSeq: parsed.eventSeq,
        runId: parsed.runId,
        taskId: parsed.taskId,
        sessionId: parsed.sessionId,
        terminalId: parsed.terminalId,
        payload: parsed.payload,
        principal: parsed.principal,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        hookId: row.uuid,
        eventSeq: parsed.eventSeq,
        outcome: "forbidden",
        observedAt: new Date().toISOString(),
        outputBytes: 0,
        payloadDigest: "",
        failureCode: "INTERNAL",
        failureMessage: `Hook dispatcher caught error: ${message}`,
      };
    }
    outcomes.push(result);
    if (result.outcome === "fired") fired++;
    else refused++;
  }
  return { fired, refused, outcomes };
}

/**
 * Test seam: clear the process-global state. Production
 * callers never invoke this.
 */
export function resetHookRuntimeState(): void {
  resetHookInflight();
  resetHookRecursion();
}

void HOOK_ACTION_OUTPUT_LINE_MAX;
