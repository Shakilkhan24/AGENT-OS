/**
 * M2.7 — Reconcile surviving execution against the restored state.
 *
 * After a backup has been restored, tmux may still own terminals that are
 * no longer represented in the new state (orphan), or the new state may
 * reference terminals that tmux has lost (missing). Reconciliation walks
 * the terminal rows in the DB and the alive execution namespace and
 * produces a typed diff so the runtime can:
 *  - mark `missing` terminals as `deleted = 1` with a `deletion_policy =
 *    "survivor-gone"` so the renderer hides them;
 *  - record `orphan` tmux sessions in `event` so an audit row exists, but
 *    does NOT touch tmux itself — those panes belong to the user.
 *
 * The reconciler is dependency-free with respect to tmux: callers pass in
 * a `discoverSurviving` callback that returns the set of live terminal
 * IDs (UUIDs). The default implementation in the runtime talks to the
 * engine; tests pass a stub so the behaviour is observable without tmux.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";

const TERMINAL_TABLE_COLUMNS = [
  "uuid", "session_id", "label", "cwd", "command", "created_at",
  "deleting", "deletion_policy", "launch_error", "started_at", "ended_at",
  "exit_signal", "exit_code", "metadata_json", "env_json", "env_profile_id",
  "prompt_anchors_json", "launch_state", "origin_hook_id",
] as const;

export const reconcileReportSchema = z.object({
  /** DB rows whose UUID is not present in the surviving set. */
  missing: z.array(z.string().uuid()),
  /** Surviving UUIDs that are not present in the DB at all (orphans). */
  orphan: z.array(z.string().uuid()),
  /** DB rows that are present both in the DB and in the surviving set. */
  aligned: z.array(z.string().uuid()),
});
export type ReconcileReport = z.infer<typeof reconcileReportSchema>;

export interface ReconcileOptions {
  worker: DbWorker;
  /** Returns the set of UUIDs that are still alive in the execution namespace. */
  discoverSurviving: () => Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /** Optional override of the deletion policy applied to missing rows. */
  missingPolicy?: string;
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

/** Diff DB terminals against the surviving execution namespace and mark the DB accordingly. */
export async function reconcileSurvivingExecution(options: ReconcileOptions): Promise<ReconcileReport> {
  const driver = driverOf(options.worker);
  const surviving = await options.discoverSurviving();
  if (!(surviving instanceof Set))
    throw new AppError("INVALID_REQUEST", "discoverSurviving must return a Set");
  const rows = driver.prepare("SELECT uuid, deletion_policy FROM terminal").all();
  const report: ReconcileReport = { missing: [], orphan: [], aligned: [] };
  const missingPolicy = options.missingPolicy ?? "survivor-gone";
  // Compute the next sequence ahead of the insert: the in-memory driver does
  // not support `(SELECT MAX(seq)+1 ...)` as an expression, but `node:sqlite`
  // would. We standardise on a separate read here so both drivers behave.
  const maxRow = driver.prepare("SELECT seq FROM event ORDER BY seq DESC LIMIT 1").first();
  const nextSeq = maxRow ? Number((maxRow as Record<string, unknown>).seq ?? 0) + 1 : 1;
  await options.worker.transaction(tx => {
    void tx;
    for (const row of rows) {
      const uuid = String((row as Record<string, unknown>).uuid);
      if (!surviving.has(uuid)) {
        report.missing.push(uuid);
        driver.prepare("UPDATE terminal SET deleting = ?, deletion_policy = ? WHERE uuid = ?")
          .run(1, missingPolicy, uuid);
      } else {
        report.aligned.push(uuid);
      }
    }
    for (const uuid of surviving) {
      const inDb = rows.some(row => String((row as Record<string, unknown>).uuid) === uuid);
      if (!inDb) report.orphan.push(uuid);
    }
    // Emit an audit event with the diff so a `replaySince` caller sees the
    // reconciliation deterministically.
    driver.prepare(
      "INSERT INTO event (seq, at, correlation_id, source_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      nextSeq,
      new Date().toISOString(),
      `${Date.now()}-reconcile`,
      "reconcile",
      "execution.reconciled",
      JSON.stringify({ missing: report.missing, orphan: report.orphan, aligned: report.aligned.length }),
    );
  });
  return report;
}

/**
 * Tiny helper for callers that already have a `Set` from `tmux list-panes -F '#{pane_id}'`
 * or any other source. Defensive: rejects undefined inputs.
 */
export function withSurvivingSet(items: Iterable<string> | undefined | null): ReadonlySet<string> {
  if (items === undefined || items === null) throw new AppError("INVALID_REQUEST", "Surviving set is required");
  return new Set(items);
}

/** Exported for callers that want to assert the terminal DDL aligns. */
export const terminalTableColumns: ReadonlyArray<string> = [...TERMINAL_TABLE_COLUMNS];
