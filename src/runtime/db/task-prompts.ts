/**
 * M3c.5 — task-prompt drafts.
 *
 * Task prompts are NOT file drafts; the existing `draft` table is
 * intentionally file-bound (`db/drafts.ts:78-79` calls
 * `computeRootIdentity` which `stat()`s the path and refuses
 * non-filesystem paths). M3c.5 stores prompt text in the `meta`
 * table following the same pattern as `draft:restored:<id>` at
 * `db/drafts.ts:157-170` — keys like
 * `task-prompt-draft:<taskUuid>` carrying a small JSON payload.
 *
 * Optimistic-update mirror: callers pass `expectedRevision`; the
 * runtime refuses mismatches with `CONFLICT`, identical to
 * `saveDraft`'s contract. The renderer keeps the live revision
 * counter in component state and increments it after each accepted
 * save.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";

/** Meta key prefix; the task UUID completes the key. */
export const TASK_PROMPT_META_PREFIX = "task-prompt-draft:";

function metaKey(taskId: string): string {
  return `${TASK_PROMPT_META_PREFIX}${taskId}`;
}

/** Public shape: the prompt text + opaque baseHash + revision counter. */
export interface TaskPromptDraft {
  readonly content: string;
  readonly baseHash: string;
  readonly updatedAt: string;
  readonly revision: number;
}

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

const TASK_PROMPT_TASK_ID = z.string().uuid();

const SAVE_INPUT = z.object({
  content: z.string().max(64 * 1024),
  /**
   * Opaque content hash; the renderer passes `"0".repeat(64)` for
   * prompts (no upstream file). Kept distinct from `content` so a
   * future M5+ integration can hash the prompt body if a sync
   * target appears.
   */
  baseHash: z.string().regex(/^[a-f0-9]{64}$/),
  /**
   * Optimistic-update revision. `null` means "create or replace
   * unconditionally" (used on first save before any revision is
   * known). Otherwise the runtime rejects mismatches with CONFLICT.
   */
  expectedRevision: z.number().int().min(0).max(1024).nullable(),
}).strict();
export type SaveTaskPromptDraftInput = z.input<typeof SAVE_INPUT>;

/** Read a draft. Returns `undefined` when no draft has been saved yet. */
export async function readTaskPromptDraft(worker: DbWorker, taskId: string): Promise<TaskPromptDraft | undefined> {
  const parsed = TASK_PROMPT_TASK_ID.parse(taskId);
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?").first(metaKey(parsed));
  if (!row) return undefined;
  return parsePayload(String((row as Record<string, unknown>).value));
}

/**
 * Save a draft. Refuses an optimistic-update mismatch with
 * `CONFLICT` (mirroring `saveDraft`'s contract). On success returns
 * the freshly assigned revision and the new `updatedAt` timestamp so
 * the renderer can keep its counter in sync.
 */
export async function saveTaskPromptDraft(worker: DbWorker, taskId: string, input: SaveTaskPromptDraftInput): Promise<TaskPromptDraft> {
  const parsedTaskId = TASK_PROMPT_TASK_ID.parse(taskId);
  const parsed = SAVE_INPUT.parse(input);
  const driver = driverOf(worker);
  const key = metaKey(parsedTaskId);
  let result: TaskPromptDraft | undefined;
  await worker.transaction(tx => {
    void tx;
    const existing = driver.prepare("SELECT value FROM meta WHERE key = ?").first(key);
    const currentRevision = existing ? parseRevision(String((existing as Record<string, unknown>).value)) : 0;
    if (parsed.expectedRevision !== null && parsed.expectedRevision !== currentRevision)
      throw new AppError(
        "CONFLICT",
        `Task-prompt draft was modified by another writer (expected r${parsed.expectedRevision}, found r${currentRevision})`,
        { sourceId: "task-prompts" },
      );
    const nextRevision = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    const payload: TaskPromptDraft = {
      content: parsed.content,
      baseHash: parsed.baseHash,
      updatedAt,
      revision: nextRevision,
    };
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify(payload));
    result = payload;
  });
  if (!result) throw new AppError("UNAVAILABLE", "Task-prompt draft save did not produce a payload");
  return result;
}

/** Remove a draft entirely. Idempotent: missing drafts are a no-op. */
export async function removeTaskPromptDraft(worker: DbWorker, taskId: string): Promise<void> {
  const parsed = TASK_PROMPT_TASK_ID.parse(taskId);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare("DELETE FROM meta WHERE key = ?").run(metaKey(parsed));
  });
}

function parseRevision(serialized: string): number {
  // Tolerate extra whitespace; embedded payloads are JSON.
  const trimmed = serialized.trim();
  if (trimmed.length === 0) return 0;
  try {
    const obj = JSON.parse(trimmed) as unknown;
    if (obj && typeof obj === "object" && "revision" in obj) {
      const candidate = (obj as Record<string, unknown>).revision;
      const n = Number(candidate);
      if (Number.isInteger(n) && n >= 0 && n <= 1024) return n;
    }
  } catch {
    /* fall through */
  }
  return 0;
}

function parsePayload(serialized: string): TaskPromptDraft {
  const trimmed = serialized.trim();
  if (trimmed.length === 0)
    throw new AppError("UNAVAILABLE", "Task-prompt draft payload is empty");
  let obj: unknown;
  try {
    obj = JSON.parse(trimmed);
  } catch (error) {
    throw new AppError(
      "UNAVAILABLE",
      `Task-prompt draft payload is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!obj || typeof obj !== "object")
    throw new AppError("UNAVAILABLE", "Task-prompt draft payload is not an object");
  const record = obj as Record<string, unknown>;
  const content = String(record.content ?? "");
  const baseHash = String(record.baseHash ?? "");
  const updatedAt = String(record.updatedAt ?? "");
  const revision = Number(record.revision ?? 0);
  if (!/^[a-f0-9]{64}$/.test(baseHash))
    throw new AppError("UNAVAILABLE", "Task-prompt draft baseHash is malformed");
  if (!Number.isInteger(revision) || revision < 1 || revision > 1024)
    throw new AppError("UNAVAILABLE", "Task-prompt draft revision is malformed");
  return { content, baseHash, updatedAt, revision };
}
