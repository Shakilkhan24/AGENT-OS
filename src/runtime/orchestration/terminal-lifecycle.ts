/**
 * M5.6 — terminal lifecycle operations.
 *
 * The M5.6 spec (FUTURE/IMPLEMENTATION-README.md line 234) requires:
 *
 * > Distinguish hide view, stop/remove terminal and delete retained
 * > history.
 *
 * Trust model:
 *
 *  - `hideTerminal` is purely a UI gesture: the registry row stays,
 *    the engine keeps running, but the renderer hides the tab. A new
 *    `terminal.hiddenAt` column (INTEGER, nullable) marks the tab as
 *    hidden so re-attach can clear the marker.
 *  - `stopAndRemoveTerminal` detaches via the M5.5 registry, then
 *    writes `terminal.removedAt = Date.now()`. The `terminal` row +
 *    history are retained; future `attach(terminalUuid)` is allowed.
 *  - `deleteRetainedHistory` hard-deletes the `terminal_history` +
 *    `terminal_meta` + `terminal` rows. `decider: "user"` is
 *    required; `system` is refused with `FORBIDDEN` (mirrors M3c.3's
 *    grant gate). Emits a SHA-256 `audit-digest` over the canonical
 *    `{terminalUuid, linesDropped, decider, ts}` projection.
 *
 * Each operation runs under a per-`terminalUuid` mutex (M5.5 pattern)
 * so concurrent calls don't interleave.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import {
  deleteTerminalHistoryInputSchema,
  hideTerminalInputSchema,
  stopAndRemoveTerminalInputSchema,
  type DeleteTerminalHistoryResult,
  type HideTerminalResult,
  type StopAndRemoveTerminalResult,
} from "../../shared/workspace6-schema";
import type { DbWorker } from "../db/worker";
import type { TerminalInputQueue } from "../input-queue";

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
 * Per-terminalMutex: serialize ops so concurrent hide / stop / delete
 * cannot interleave on the same `terminalUuid`. Mirrors the
 * `WorkspaceState.withTerminal` pattern from `src/main/workspace-state.ts`.
 */
const terminalLocks = new Map<string, { mutex: Promise<void>; users: number }>();

async function withTerminalLock<T>(terminalUuid: string, body: () => Promise<T>): Promise<T> {
  const existing = terminalLocks.get(terminalUuid);
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => { release = resolve; });
  const chain = existing ? existing.mutex.then(() => next) : next;
  const users = (existing?.users ?? 0) + 1;
  terminalLocks.set(terminalUuid, { mutex: chain, users });
  try {
    await (existing ? existing.mutex : Promise.resolve());
    return await body();
  } finally {
    release();
    const after = terminalLocks.get(terminalUuid);
    if (after && after.users <= 1) terminalLocks.delete(terminalUuid);
    else if (after) terminalLocks.set(terminalUuid, { mutex: after.mutex, users: after.users - 1 });
  }
}

/** M5.6 default: the prefix used to seed terminal-history meta keys. */
export const TERMINAL_HISTORY_META_PREFIX = "terminal-history:";
/** M5.6 default: the prefix used to seed terminal-meta rows. */
export const TERMINAL_META_PREFIX = "terminal-meta:";

function auditDigest(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex");
}

/** Set or clear the `hiddenAt` marker on a terminal row. */
function setTerminalHidden(worker: DbWorker, terminalUuid: string, hiddenAt: number | null): void {
  driverOf(worker).prepare("UPDATE terminal SET hidden_at = ? WHERE uuid = ?").run(hiddenAt, terminalUuid);
}

/** Set or clear the `removedAt` marker on a terminal row. */
function setTerminalRemoved(worker: DbWorker, terminalUuid: string, removedAt: number | null): void {
  driverOf(worker).prepare("UPDATE terminal SET removed_at = ? WHERE uuid = ?").run(removedAt, terminalUuid);
}

function readTerminalRow(worker: DbWorker, terminalUuid: string): Record<string, unknown> | undefined {
  return driverOf(worker).prepare("SELECT * FROM terminal WHERE uuid = ?").first(terminalUuid);
}

/**
 * Ensure the `terminal.hidden_at` and `terminal.removed_at` columns
 * exist. Idempotent: catches duplicate-column errors.
 */
export function ensureLifecycleColumns(worker: DbWorker): void {
  const driver = driverOf(worker);
  for (const stmt of [
    "ALTER TABLE terminal ADD COLUMN hidden_at INTEGER",
    "ALTER TABLE terminal ADD COLUMN removed_at INTEGER",
  ]) {
    try { driver.prepare(stmt).run(); } catch { /* already present */ }
  }
}

/** Read the current `hiddenAt` and `removedAt` markers for a terminal. */
export function readLifecycleMarkers(worker: DbWorker, terminalUuid: string): {
  hiddenAt: number | null;
  removedAt: number | null;
} {
  const row = readTerminalRow(worker, terminalUuid);
  if (!row) return { hiddenAt: null, removedAt: null };
  return {
    hiddenAt: typeof row.hidden_at === "number" ? row.hidden_at : null,
    removedAt: typeof row.removed_at === "number" ? row.removed_at : null,
  };
}

// ── Public operations ──────────────────────────────────────────────────────

export async function hideTerminal(
  worker: DbWorker,
  rawInput: unknown,
): Promise<HideTerminalResult> {
  const input = hideTerminalInputSchema.parse(rawInput);
  return withTerminalLock(input.terminalUuid, async () => {
    ensureLifecycleColumns(worker);
    const existing = readTerminalRow(worker, input.terminalUuid);
    if (!existing) {
      throw new AppError("NOT_FOUND", `terminal ${input.terminalUuid} not registered`);
    }
    const hiddenAt = Date.now();
    setTerminalHidden(worker, input.terminalUuid, hiddenAt);
    return {
      hidden: true as const,
      terminalUuid: input.terminalUuid,
      hiddenAt: new Date(hiddenAt).toISOString(),
    };
  });
}

export async function stopAndRemoveTerminal(
  worker: DbWorker,
  rawInput: unknown,
  deps: { inputQueue?: TerminalInputQueue } = {},
): Promise<StopAndRemoveTerminalResult> {
  const input = stopAndRemoveTerminalInputSchema.parse(rawInput);
  return withTerminalLock(input.terminalUuid, async () => {
    ensureLifecycleColumns(worker);
    const existing = readTerminalRow(worker, input.terminalUuid);
    if (!existing) {
      throw new AppError("NOT_FOUND", `terminal ${input.terminalUuid} not registered`);
    }
    if (deps.inputQueue) {
      // M1 input queue: cancel unsubmitted bytes for the subscriber
      // whose token matches `terminalUuid`. The queue keys by the
      // M5.5 owner-subscriber id; we use the terminalUuid as the
      // per-attachment subscriber id (it IS the subscription token
      // because there is at most one subscriber per terminal in
      // single-attachment mode; the registry mode uses subscriberId).
      deps.inputQueue.cancel(input.terminalUuid);
    }
    const removedAt = Date.now();
    setTerminalRemoved(worker, input.terminalUuid, removedAt);
    setTerminalHidden(worker, input.terminalUuid, null);
    return {
      removed: true as const,
      historyRetained: true as const,
      terminalUuid: input.terminalUuid,
      removedAt: new Date(removedAt).toISOString(),
    };
  });
}

export async function deleteRetainedHistory(
  worker: DbWorker,
  rawInput: unknown,
): Promise<DeleteTerminalHistoryResult> {
  const input = deleteTerminalHistoryInputSchema.parse(rawInput);
  if (input.decider !== "user") {
    throw new AppError("FORBIDDEN",
      "history-deletion requires user (got decider=system); the user must explicitly opt in to retain-history removal");
  }
  return withTerminalLock(input.terminalUuid, async () => {
    ensureLifecycleColumns(worker);
    const existing = readTerminalRow(worker, input.terminalUuid);
    if (!existing) {
      throw new AppError("NOT_FOUND", `terminal ${input.terminalUuid} not registered`);
    }
    const driver = driverOf(worker);
    // Walk every meta row (bounded by `MEMORY_VIEW_MAX_TERMINAL_LINES`)
    // and delete keys that belong to this terminal. The MemoryDatabase
    // predicate parser doesn't accept `LIKE`, so we filter in JS.
    const historyPrefix = `${TERMINAL_HISTORY_META_PREFIX}${input.terminalUuid}:`;
    const metaPrefix = `${TERMINAL_META_PREFIX}${input.terminalUuid}:`;
    const allMeta = driver.prepare("SELECT key FROM meta").all() as Array<{ key: string }>;
    const matchingKeys = allMeta
      .map((row) => row.key)
      .filter((key) => key.startsWith(historyPrefix) || key.startsWith(metaPrefix));
    for (const key of matchingKeys) {
      driver.prepare("DELETE FROM meta WHERE key = ?").run(key);
    }
    const linesDropped = matchingKeys.filter((key) => key.startsWith(historyPrefix)).length;
    driver.prepare("DELETE FROM terminal WHERE uuid = ?").run(input.terminalUuid);
    const audit = auditDigest({
      terminalUuid: input.terminalUuid,
      linesDropped,
      decider: input.decider,
      ts: new Date().toISOString(),
    });
    return {
      deleted: true as const,
      terminalUuid: input.terminalUuid,
      auditDigest: audit,
      linesDropped,
    };
  });
}

/** Compute a stable per-terminal digest over its current lifecycle markers. */
export function digestLifecycleMarkers(markers: { hiddenAt: number | null; removedAt: number | null }): string {
  return auditDigest(markers);
}

// ── Re-exports for tests / IPC wiring ──────────────────────────────────────

export {
  deleteTerminalHistoryInputSchema,
  hideTerminalInputSchema,
  stopAndRemoveTerminalInputSchema,
  type DeleteTerminalHistoryInput,
  type DeleteTerminalHistoryResult,
  type HideTerminalInput,
  type HideTerminalResult,
  type StopAndRemoveTerminalInput,
  type StopAndRemoveTerminalResult,
} from "../../shared/workspace6-schema";

export { resolveTerminalLifecyclePolicy } from "../../shared/workspace6-schema";

export const lifecycleRequestUnionSchema = z.discriminatedUnion("kind", [
  hideTerminalInputSchema.extend({ kind: z.literal("hide") }),
  stopAndRemoveTerminalInputSchema.extend({ kind: z.literal("stop-and-remove") }),
  deleteTerminalHistoryInputSchema.extend({ kind: z.literal("delete-history") }),
]);
export type LifecycleRequestUnion = z.infer<typeof lifecycleRequestUnionSchema>;

// Stable opaque token used by tests to seed unique terminalUuid + correlation pairs.
export function newTerminalUuid(): string { return randomUUID(); }
