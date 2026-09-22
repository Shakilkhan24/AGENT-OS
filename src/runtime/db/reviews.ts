/**
 * M3c.2 — `review` entity service.
 *
 * A review is the acceptance state machine bound to a candidate. The
 * binding is `(candidate identity triple, configuration revision,
 * evidence verification ids)`. State machine:
 *
 *   open → accepted  (only when every required check is `passed`)
 *   open → rejected  (always allowed)
 *   open → invalidated  (auto; on candidate/evidence mutation)
 *
 * `accepted`, `rejected`, and `invalidated` are terminal. Each
 * transition writes a `decision` field for audit.
 *
 * `invalidateOpenReviewsForRun(worker, runId, reason)` is the seam the
 * lease-gate calls after a successful mutation that advances the
 * candidate's `head_revision` or otherwise changes the dirty set.
 * Invalidated reviews trigger an `attention_item` of `kind: "review"`
 * so the M3c.3 inbox surfaces the staleness.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { reviewRowSchema } from "./schema";
import { reviewDecisionSchema, reviewStatusSchema, type Review, type ReviewStatus } from "../../shared/managed";
import { raiseAttention } from "./attention-items";
import type { DbWorker } from "./worker";

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

const REVIEW_TRANSITIONS: Record<ReviewStatus, ReadonlyArray<ReviewStatus>> = {
  open: ["accepted", "rejected", "invalidated"],
  accepted: [],
  rejected: [],
  invalidated: [],
};

const createOpenReviewSchema = z.object({
  taskId: z.string().uuid().nullable().default(null),
  runId: z.string().uuid().nullable().default(null),
  evidenceVerificationIds: z.array(z.string().uuid()).default([]),
  candidateBase: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  candidateTree: z.string().regex(/^[0-9a-f]{7,64}$/).nullable().default(null),
  candidateDiff: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  configurationRevision: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
}).strict();
export type CreateOpenReviewInput = z.input<typeof createOpenReviewSchema>;

/**
 * Insert an `open` review. The unique binding is `(task, run,
 * configurationRevision, candidateTree)` — re-opening a review for the
 * same candidate at the same configuration is one row, not many.
 */
export async function createOpenReview(worker: DbWorker, input: CreateOpenReviewInput): Promise<Review> {
  const parsed = createOpenReviewSchema.parse(input);
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO review (uuid, task_id, run_id, evidence_verification_ids_json, " +
      "candidate_base, candidate_tree, candidate_diff, configuration_revision, " +
      "status, decision, decided_by, decision_note, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.taskId, parsed.runId,
      JSON.stringify(parsed.evidenceVerificationIds),
      parsed.candidateBase, parsed.candidateTree, parsed.candidateDiff,
      parsed.configurationRevision,
      "open", null, null, null, now, now,
    );
  });
  const read = await readReview(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Review disappeared after insert");
  return read;
}

export async function readReview(worker: DbWorker, id: string): Promise<Review | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM review WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseReviewRow(row);
}

export async function listReviewsForTask(worker: DbWorker, taskId: string): Promise<Review[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM review WHERE task_id = ? ORDER BY created_at ASC").all(taskId);
  return rows.map(parseReviewRow);
}

export async function listReviewsForRun(worker: DbWorker, runId: string): Promise<Review[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM review WHERE run_id = ? ORDER BY created_at ASC").all(runId);
  return rows.map(parseReviewRow);
}

/** Flat list — used by the projection. */
export async function listReviews(worker: DbWorker): Promise<Review[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM review ORDER BY created_at ASC").all();
  return rows.map(parseReviewRow);
}

/** Inline transition wrapper. Used internally by `accept/reject/invalidate`. */
async function transitionTo(worker: DbWorker, id: string, to: ReviewStatus, extra: {
  decision?: "accepted" | "rejected";
  decidedBy?: string | null;
  decisionNote?: string | null;
}): Promise<Review> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM review WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Review not found");
    const from = reviewStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!REVIEW_TRANSITIONS[from].includes(to))
      throw new AppError("CONFLICT", `Illegal review transition ${from} → ${to}`);
    const now = new Date().toISOString();
    const updates: string[] = ["status = ?", "updated_at = ?"];
    const values: unknown[] = [to, now];
    if (extra.decision !== undefined) {
      reviewDecisionSchema.parse(extra.decision);
      updates.push("decision = ?"); values.push(extra.decision);
    }
    if (extra.decidedBy !== undefined) { updates.push("decided_by = ?"); values.push(extra.decidedBy); }
    if (extra.decisionNote !== undefined) { updates.push("decision_note = ?"); values.push(extra.decisionNote); }
    values.push(id);
    driver.prepare(`UPDATE review SET ${updates.join(", ")} WHERE uuid = ?`).run(...values);
  });
  const after = await readReview(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Review disappeared after transition");
  return after;
}

const ACCEPT_INPUT = z.object({
  decidedBy: z.string().min(1).max(256),
  decisionNote: z.string().max(8 * 1024).nullable().optional(),
}).strict();
export type AcceptReviewInput = z.input<typeof ACCEPT_INPUT>;

const REJECT_INPUT = z.object({
  decidedBy: z.string().min(1).max(256),
  decisionNote: z.string().max(8 * 1024).nullable().optional(),
}).strict();
export type RejectReviewInput = z.input<typeof REJECT_INPUT>;

/**
 * Accept an open review. Refuses to accept if any required check on
 * every backing verification is not `passed` — the executor is the
 * sole authority on what `passed` means; the service enforces the gate.
 */
export async function acceptReview(worker: DbWorker, id: string, input: AcceptReviewInput): Promise<Review> {
  const parsed = ACCEPT_INPUT.parse(input);
  // Verify all required checks on all evidence rows are `passed`. The
  // backing verification rows are read fresh in the same transaction;
  // we don't trust a stale decisionNote.
  await worker.transaction(tx => {
    void tx;
    const row = driverOf(worker).prepare("SELECT * FROM review WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Review not found");
    const review = parseReviewRow(row);
    if (review.status !== "open")
      throw new AppError("CONFLICT", `Review already ${review.status}`);
    const ids = JSON.parse(review.evidenceVerificationIdsJson) as ReadonlyArray<string>;
    if (ids.length === 0)
      throw new AppError("CONFLICT", "Review has no backing verification rows; cannot accept");
    for (const verificationId of ids) {
      const vrow = driverOf(worker).prepare("SELECT status, required_check_results_json FROM verification WHERE uuid = ?")
        .first(verificationId);
      if (!vrow) throw new AppError("CONFLICT", `Evidence verification ${verificationId} not found`);
      const status = String((vrow as Record<string, unknown>).status);
      if (status !== "passed")
        throw new AppError("CONFLICT", `Evidence verification ${verificationId} is ${status}, not passed`);
      const results = JSON.parse(String((vrow as Record<string, unknown>).required_check_results_json)) as ReadonlyArray<{ name: string; status: string }>;
      const unmet = results.filter(result => result.status !== "passed");
      if (unmet.length > 0)
        throw new AppError("CONFLICT", `Required check(s) not passed: ${unmet.map(r => r.name).join(", ")}`);
    }
  });
  return transitionTo(worker, id, "accepted", {
    decision: "accepted",
    decidedBy: parsed.decidedBy,
    decisionNote: parsed.decisionNote ?? null,
  });
}

export async function rejectReview(worker: DbWorker, id: string, input: RejectReviewInput): Promise<Review> {
  const parsed = REJECT_INPUT.parse(input);
  return transitionTo(worker, id, "rejected", {
    decision: "rejected",
    decidedBy: parsed.decidedBy,
    decisionNote: parsed.decisionNote ?? null,
  });
}

/**
 * Mark every `open` review for the given `runId` as `invalidated`.
 * Called by the lease-gate after a successful mutation that advances
 * the workspace's `head_revision` or rewrites the dirty set. Each
 * invalidation also raises an `attention_item(kind: review)` so the
 * M3c.3 inbox surfaces the staleness. Returns the count of reviews
 * transitioned.
 */
export async function invalidateOpenReviewsForRun(
  worker: DbWorker,
  runId: string,
  reason: string,
): Promise<{ invalidated: Review[]; attentionIds: string[] }> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  const invalidated: Review[] = [];
  const attentionIds: string[] = [];
  await worker.transaction(tx => {
    void tx;
    const rows = driver.prepare(
      "SELECT * FROM review WHERE run_id = ? AND status = 'open'",
    ).all(runId);
    for (const row of rows) {
      const id = String((row as Record<string, unknown>).uuid);
      driver.prepare("UPDATE review SET status = 'invalidated', updated_at = ? WHERE uuid = ?")
        .run(now, id);
      invalidated.push(parseReviewRow({ ...row, status: "invalidated", updated_at: now }));
    }
  });
  // After the transaction, raise one attention item per affected review
  // (issue identity groups reviews invalidated in the same event, so the
  // inbox dedupes them in the renderer's M3c.3 surface).
  for (const review of invalidated) {
    const attention = await raiseAttention(worker, {
      taskId: review.taskId,
      kind: "review",
      issueIdentity: `review:${review.id}`,
      revision: 0,
      payload: { reason, invalidatedAt: now },
    });
    attentionIds.push(attention.id);
  }
  return { invalidated, attentionIds };
}

function parseReviewRow(row: Record<string, unknown>): Review {
  const parsed = reviewRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    taskId: row.task_id == null ? null : String(row.task_id),
    runId: row.run_id == null ? null : String(row.run_id),
    evidenceVerificationIdsJson: String(row.evidence_verification_ids_json ?? "[]"),
    candidateBase: row.candidate_base == null ? null : String(row.candidate_base),
    candidateTree: row.candidate_tree == null ? null : String(row.candidate_tree),
    candidateDiff: row.candidate_diff == null ? null : String(row.candidate_diff),
    configurationRevision: row.configuration_revision == null ? null : String(row.configuration_revision),
    status: String(row.status),
    decision: row.decision == null ? null : String(row.decision),
    decidedBy: row.decided_by == null ? null : String(row.decided_by),
    decisionNote: row.decision_note == null ? null : String(row.decision_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}
