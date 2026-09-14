/**
 * M2.6 — Draft revision + root identity.
 *
 * The draft store extends the JSON-backed `DraftStore` (M1.x) with:
 *  - a per-draft `revision` counter that the renderer must echo back to
 *    opt in to an optimistic update check;
 *  - a per-file `rootIdentity` (device + inode) recorded when a draft is
 *    first created; subsequent saves verify the identity is unchanged
 *    so an externally-rewritten file is surfaced as a conflict instead
 *    of silently overwriting;
 *  - durable acknowledgement: a save returns its assigned revision and
 *    the updated `updatedAt` timestamp so the renderer can keep its
 *    optimistic edit history accurate across crashes;
 *  - explicit restore-as-unsaved: a recovered draft is marked with
 *    `restoredFrom: <previousUpdatedAt>` so the renderer can decide to
 *    surface the prompt as unsaved rather than auto-submitting it.
 *
 * The `baseHash` from M1.x is preserved verbatim; this module deliberately
 * does not introduce a redundant `expectedHash` field on the same draft.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { draftInputSchema, draftSchema, type Draft, type DraftInput, type DraftSummary } from "../../shared/drafts";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";

export const draftRevisionSchema = z.object({
  revision: z.number().int().min(1),
  updatedAt: z.string().datetime(),
  rootIdentity: z.string().min(1).max(256),
});

export type DraftRevision = z.infer<typeof draftRevisionSchema>;

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

function digestId(sessionUuid: string, filePath: string): string {
  return createHash("sha256").update(`${sessionUuid}\0${filePath}`).digest("hex");
}

interface RootIdentityInputs { sessionId: string; path: string }

/**
 * Compute the device+inode identity of the file backing a draft. Returns
 * `undefined` when the file is missing so callers can surface a typed
 * "file no longer exists" error rather than fabricate an identity.
 */
export async function computeRootIdentity(input: RootIdentityInputs): Promise<string | undefined> {
  try {
    const info = await stat(path.resolve(input.path));
    return `${info.dev}:${info.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Save a draft, returning the assigned revision. Optimistic updates pass
 * the `expectedRevision`; mismatches throw `CONFLICT`. A new draft is
 * stored with `revision = 1`.
 */
export async function saveDraft(worker: DbWorker, sessionId: string, draft: DraftInput, options: { expectedRevision?: number; rootIdentity?: string } = {}): Promise<{ summary: DraftSummary; revision: DraftRevision }> {
  draft = draftInputSchema.parse(draft);
  const id = digestId(sessionId, draft.path);
  const rootIdentity = options.rootIdentity ?? await computeRootIdentity({ sessionId, path: draft.path });
  if (!rootIdentity) throw new AppError("NOT_FOUND", "Draft target file no longer exists", { sourceId: "drafts" });
  const driver = driverOf(worker);
  let next: DraftSummary | undefined;
  await worker.transaction(tx => {
    void tx;
    const existing = driver.prepare("SELECT revision, updated_at, root_identity FROM draft WHERE id = ?").first(id);
    const currentRevision = existing ? Number((existing as Record<string, unknown>).revision ?? 1) : 0;
    if (options.expectedRevision !== undefined && options.expectedRevision !== currentRevision)
      throw new AppError("CONFLICT", `Draft was modified by another writer (expected r${options.expectedRevision}, found r${currentRevision})`, { sourceId: "drafts" });
    const stored = (existing as Record<string, unknown> | undefined)?.root_identity;
    if (stored && String(stored) !== rootIdentity)
      throw new AppError("CONFLICT", "Draft target was rewritten externally; review the change before saving", { sourceId: "drafts" });
    const assigned = currentRevision + 1;
    const updatedAt = new Date().toISOString();
    if (existing) {
      driver.prepare("UPDATE draft SET content = ?, base_hash = ?, root_identity = ?, revision = ?, updated_at = ? WHERE id = ?")
        .run(draft.content, draft.baseHash, rootIdentity, assigned, updatedAt, id);
    } else {
      driver.prepare("INSERT INTO draft (id, session_uuid, path, base_hash, content, revision, updated_at, root_identity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(id, sessionId, draft.path, draft.baseHash, draft.content, assigned, updatedAt, rootIdentity);
    }
    next = { id, sessionId, path: draft.path, baseHash: draft.baseHash, updatedAt };
  });
  if (!next) throw new AppError("UNAVAILABLE", "Draft save did not produce a summary");
  // Re-read the persisted revision+updatedAt so the caller observes the
  // committed values, not the local computation.
  const finalRow = driver.prepare("SELECT revision, updated_at, root_identity FROM draft WHERE id = ?").first(id);
  if (!finalRow) throw new AppError("UNAVAILABLE", "Draft disappeared after save");
  return {
    summary: next,
    revision: {
      revision: Number((finalRow as Record<string, unknown>).revision),
      updatedAt: String((finalRow as Record<string, unknown>).updated_at),
      rootIdentity: String((finalRow as Record<string, unknown>).root_identity),
    },
  };
}

export async function readDraft(worker: DbWorker, id: string): Promise<Draft> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM draft WHERE id = ?").first(id);
  if (!row) throw new AppError("NOT_FOUND", "Draft no longer exists", { sourceId: "drafts" });
  return draftSchema.parse({
    id: String((row as Record<string, unknown>).id),
    sessionId: String((row as Record<string, unknown>).session_uuid),
    path: String((row as Record<string, unknown>).path),
    baseHash: String((row as Record<string, unknown>).base_hash),
    content: String((row as Record<string, unknown>).content),
    updatedAt: String((row as Record<string, unknown>).updated_at),
  });
}

export async function listDrafts(worker: DbWorker): Promise<DraftSummary[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT id, session_uuid, path, base_hash, updated_at FROM draft ORDER BY updated_at DESC").all();
  return rows.map(row => ({
    id: String((row as Record<string, unknown>).id),
    sessionId: String((row as Record<string, unknown>).session_uuid),
    path: String((row as Record<string, unknown>).path),
    baseHash: String((row as Record<string, unknown>).base_hash),
    updatedAt: String((row as Record<string, unknown>).updated_at),
  }));
}

export async function removeDraft(worker: DbWorker, id: string): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare("DELETE FROM draft WHERE id = ?").run(id);
  });
}

/**
 * Mark a draft as "restored from a previous save" by stamping a
 * `restoredFrom` row in `meta`. The renderer reads this flag to decide
 * whether to surface the prompt as unsaved (it must never auto-submit
 * a restored task prompt).
 */
export async function markRestored(worker: DbWorker, id: string, previousUpdatedAt: string): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`draft:restored:${id}`, previousUpdatedAt);
  });
}

export async function isRestored(worker: DbWorker, id: string): Promise<{ restored: boolean; previousUpdatedAt?: string }> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?").first(`draft:restored:${id}`);
  if (!row) return { restored: false };
  return { restored: true, previousUpdatedAt: String((row as Record<string, unknown>).value) };
}
