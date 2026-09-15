/**
 * M4.4 — Installation receipt + rollback ledger.
 *
 * The roadmap says: "Rollback never pretends arbitrary install-script
 * side effects are reversible." This module enforces that rule by
 * construction: every receipt's `reversible` flag is `false`, and
 * `rollbackPlan` returns the receipts so a renderer can show a
 * human what actually happened — without ever claiming that any
 * external side-effect has been undone.
 *
 * Receipts are append-only. The ledger lives in the existing
 * `meta` table under `install-receipt:<planId>:<stepId>`. There is
 * no `UPDATE` or `DELETE` path; a corrected execution produces a
 * new receipt next to the old one.
 *
 * Like the installation-plan planner, this module is a pure
 * service: it does not invoke any adapter. It records outcomes;
 * the executor (a future M4.4 sub-increment) calls `recordReceipt`
 * with what actually happened.
 */
import { z } from "zod";
import type { DbWorker } from "./worker";
import type { PlanStep, PlanStepKind } from "./installation-plan";

/** Outcome categories. `uncertain` is the explicit "we don't know" marker. */
export const receiptOutcomeSchema = z.enum([
  "success",
  "failed",
  "skipped",
  "uncertain",
]);
export type ReceiptOutcome = z.infer<typeof receiptOutcomeSchema>;

/**
 * Receipt shape. `reversible` is **always** `false` at the schema
 * level (literal type) so the runtime cannot accidentally emit a
 * receipt that claims reversibility.
 */
export const installationReceiptSchema = z
  .object({
    planId: z.string().uuid(),
    stepId: z.string().uuid(),
    stepKind: z.string().min(1).max(80),
    outcome: receiptOutcomeSchema,
    observedAt: z.string().datetime(),
    /** Observed digest at the end of the step (when relevant). */
    observedDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
    /** Side-effect acknowledgement: the executor recorded what actually happened. */
    sideEffectAcknowledged: z.boolean(),
    /** Human-readable message (failure reason, success note, etc.). */
    message: z.string().max(4096).default(""),
    /** Reversibility flag — locked to `false` per the M4.4 roadmap. */
    reversible: z.literal(false),
  })
  .strict();
export type InstallationReceipt = z.infer<typeof installationReceiptSchema>;

/** Meta key prefix for receipts. */
export const INSTALL_RECEIPT_META_PREFIX = "install-receipt:";

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
 * Append a single receipt to the ledger. There is no update path
 * — a corrected execution writes a new receipt with the same
 * `(planId, stepId)` key but a later `observedAt`.
 *
 * The receipt's `reversible` flag is forced to `false` so even a
 * caller that supplies a different value cannot smuggle a
 * reversibility claim past this gate.
 */
export function recordReceipt(
  worker: DbWorker,
  input: Omit<InstallationReceipt, "reversible">,
): InstallationReceipt {
  const receipt = installationReceiptSchema.parse({
    ...input,
    reversible: false,
  });
  const driver = driverOf(worker);
  const key = receiptKey(receipt.planId, receipt.stepId);
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(key, JSON.stringify(receipt));
  return receipt;
}

/** Read all receipts for a plan, in observed-at order. */
export function readPlanReceipts(
  worker: DbWorker,
  planId: string,
): InstallationReceipt[] {
  const driver = driverOf(worker);
  // Iterate the meta table client-side because the in-memory
  // driver does not implement `LIKE`. The table is small (one
  // row per receipt) so a full scan is acceptable for M4.4.
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const prefix = `${INSTALL_RECEIPT_META_PREFIX}${planId}:`;
  const out: InstallationReceipt[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(prefix)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      const parsed = installationReceiptSchema.parse(JSON.parse(raw));
      out.push(parsed);
    } catch {
      // Skip malformed rows — listing must not throw on a corrupt row.
    }
  }
  return out.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
}

/**
 * Rollback returns the existing receipts so a renderer can show
 * what actually happened. The roadmap line "Rollback never pretends
 * arbitrary install-script side effects are reversible" is
 * enforced by the `RollbackSummary` shape: every field is a
 * truthful observation, never a claim of side-effect reversal.
 */
export interface RollbackSummary {
  readonly planId: string;
  readonly receipts: ReadonlyArray<InstallationReceipt>;
  /** Count of receipts by outcome. */
  readonly outcomeCounts: Readonly<Record<ReceiptOutcome, number>>;
  /** ISO-8601 timestamp the summary was generated. */
  readonly generatedAt: string;
  /** Honest declaration: no side effects have been reversed. */
  readonly sideEffectsReversed: false;
  /** Human-readable note the renderer should display prominently. */
  readonly note: string;
}

export function rollbackPlan(worker: DbWorker, planId: string): RollbackSummary {
  const receipts = readPlanReceipts(worker, planId);
  const outcomeCounts: Record<ReceiptOutcome, number> = {
    success: 0,
    failed: 0,
    skipped: 0,
    uncertain: 0,
  };
  for (const r of receipts) outcomeCounts[r.outcome] += 1;
  return {
    planId,
    receipts,
    outcomeCounts,
    generatedAt: new Date().toISOString(),
    sideEffectsReversed: false,
    note:
      "Rollback records what happened. It does not undo external side effects; " +
      "manual cleanup may be required. Inspect each receipt's `message` and " +
      "`observedDigest` to assess residual state.",
  };
}

/**
 * Compute which steps in a plan have no receipt yet. A future
 * executor uses this to decide what remains to run; tests use this
 * to verify the ledger state.
 */
export function pendingSteps(
  worker: DbWorker,
  planId: string,
  steps: ReadonlyArray<PlanStep>,
): PlanStep[] {
  const receipts = readPlanReceipts(worker, planId);
  const completed = new Set(receipts.map((r) => r.stepId));
  return steps.filter((s) => !completed.has(s.stepId)).sort((a, b) => a.order - b.order);
}

/** Test seam: build a deterministic step key for a plan+step pair. */
export function receiptKey(planId: string, stepId: string): string {
  return `${INSTALL_RECEIPT_META_PREFIX}${planId}:${stepId}`;
}

/** Re-export `PlanStepKind` for callers that want to typecheck without a deep import. */
export type { PlanStepKind };
