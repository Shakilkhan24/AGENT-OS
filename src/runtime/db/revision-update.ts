/**
 * M4.6.b — selected revision updates.
 *
 * The `run.baseRevision` column records the revision the run started
 * from. M4.6.b adds the audit trail for *revision updates* —
 * explicit user actions that point the run at a newer head revision
 * — without rewriting history.
 *
 * Storage:
 *  - Audit row in the meta table under
 *    `revision-update:<runId>:<seq>` carrying the
 *    `RevisionUpdateRecord` payload (content-addressed).
 *  - `run.base_revision` column updated to the new `headRevision`
 *    so a `readRun` sees the latest pointer.
 *
 * Trust rules:
 *  - Refuse empty / malformed `baseRevision`, `headRevision`, or
 *    `sourceDigest`. Empty fields would let two distinct revisions
 *    share a row, defeating the audit trail.
 *  - Refuse re-binding the same `(runId, baseRevision)` pair to a
 *    different `sourceDigest` with `CONFLICT`. Identity is the
 *    audited property — swapping it is a tamper attempt.
 *  - Re-binding the same `(runId, baseRevision)` to the same
 *    `sourceDigest` with a different `headRevision` is *allowed*:
 *    that is the normal "rebase onto a newer head from the same
 *    source identity" flow.
 *  - The audit `seq` is 1-based and monotonic per run.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";

export const REVISION_UPDATE_META_PREFIX = "revision-update:";

export const revisionUpdateRecordSchema = z
  .object({
    runId: z.string().uuid(),
    seq: z.number().int().min(1).max(10_000),
    baseRevision: z.string().regex(/^[0-9a-f]{7,64}$/),
    headRevision: z.string().regex(/^[0-9a-f]{7,64}$/),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    rationale: z.string().min(1).max(2048),
    actor: z.string().min(1).max(256),
    recordedAt: z.string().datetime(),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RevisionUpdateRecord = z.infer<typeof revisionUpdateRecordSchema>;

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

const recordInputSchema = z
  .object({
    runId: z.string().uuid(),
    baseRevision: z.string().regex(/^[0-9a-f]{7,64}$/),
    headRevision: z.string().regex(/^[0-9a-f]{7,64}$/),
    sourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
    rationale: z.string().min(1).max(2048),
    actor: z.string().min(1).max(256),
  })
  .strict();

/**
 * Record a revision update for a run. Writes the audit row in the meta
 * table and updates the run's `base_revision` column to `headRevision`.
 *
 * Errors:
 *  - `INVALID_REQUEST` — bad shape (empty fields).
 *  - `NOT_FOUND` — `runId` does not resolve to an existing run row.
 *  - `CONFLICT` — same `(runId, baseRevision)` is already bound to a
 *    different `sourceDigest`. Re-binding to a different identity is a
 *    tamper attempt; the existing audit row is preserved.
 */
export async function recordRevisionUpdate(
  worker: DbWorker,
  input: z.input<typeof recordInputSchema>,
): Promise<RevisionUpdateRecord> {
  let parsed: z.infer<typeof recordInputSchema>;
  try {
    parsed = recordInputSchema.parse(input);
  } catch (error) {
    throw new AppError(
      "INVALID_REQUEST",
      `Revision-update input is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const driver = driverOf(worker);

  let existingRecordCount = 0;
  let conflict: RevisionUpdateRecord | undefined;
  const recordedAt = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const runExists = driver.prepare(`SELECT uuid FROM run WHERE uuid = ?`).first(parsed.runId);
    if (!runExists) throw new AppError("NOT_FOUND", `Run ${parsed.runId} not found`);

    // Scan prior audit rows for the run. Refuse a re-bind to a different
    // `sourceDigest` for the same `baseRevision`; allow a re-bind to
    // the same `sourceDigest` (normal rebase to a newer head).
    const prior = listRevisionUpdatesInner(driver, parsed.runId);
    existingRecordCount = prior.length;
    const reBind = prior.find((r) => r.baseRevision === parsed.baseRevision);
    if (reBind && reBind.sourceDigest !== parsed.sourceDigest) {
      conflict = reBind;
      throw new AppError(
        "CONFLICT",
        `Revision update for run ${parsed.runId} baseRevision ${parsed.baseRevision} is already bound to sourceDigest ${reBind.sourceDigest} (cannot re-bind to ${parsed.sourceDigest})`,
      );
    }
    void conflict;
    const seq = existingRecordCount + 1;
    const canonical = {
      runId: parsed.runId,
      seq,
      baseRevision: parsed.baseRevision,
      headRevision: parsed.headRevision,
      sourceDigest: parsed.sourceDigest,
      rationale: parsed.rationale,
      actor: parsed.actor,
      recordedAt,
    };
    const payloadDigest = createHash("sha256")
      .update(stableStringify({ ...canonical, payloadDigest: "" }), "utf8")
      .digest("hex");
    const record: RevisionUpdateRecord = revisionUpdateRecordSchema.parse({
      ...canonical,
      payloadDigest,
    });
    driver
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(recordKey(parsed.runId, seq), JSON.stringify(record));
    driver
      .prepare(`UPDATE run SET base_revision = ?, updated_at = ? WHERE uuid = ?`)
      .run(parsed.headRevision, recordedAt, parsed.runId);
  });

  const out = listRevisionUpdates(worker, parsed.runId);
  // Return the just-appended record (highest seq for this run).
  return out[out.length - 1];
}

/** List revision-update audit rows for a run, ascending by `seq`. */
export function listRevisionUpdates(
  worker: DbWorker,
  runId: string,
): RevisionUpdateRecord[] {
  const driver = driverOf(worker);
  return listRevisionUpdatesInner(driver, runId);
}

/** Read the run's current pointer (= its `base_revision` column). */
export function readCurrentRevision(worker: DbWorker, runId: string): string | undefined {
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT base_revision FROM run WHERE uuid = ?`).first(runId);
  if (!row) return undefined;
  const val = (row as Record<string, unknown>).base_revision;
  return val == null ? undefined : String(val);
}

/** Test seam: build the meta key for a revision-update audit row. */
export function recordKey(runId: string, seq: number): string {
  return `${REVISION_UPDATE_META_PREFIX}${runId}:${seq}`;
}

function listRevisionUpdatesInner(driver: DriverRaw, runId: string): RevisionUpdateRecord[] {
  const prefix = `${REVISION_UPDATE_META_PREFIX}${runId}:`;
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const out: RevisionUpdateRecord[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(prefix)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      out.push(revisionUpdateRecordSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip malformed rows silently — listing must not throw.
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}
