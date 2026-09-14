/**
 * M3a — `context_receipt` entity service.
 *
 * A context receipt is the bounded envelope around the inputs the
 * controller hands to the provider. It records the run, the objective,
 * the constraints, the acceptance checks, the selected revisions and
 * hashes, the assembled instructions, the environment + capabilities,
 * and explicit exclusions. Secret values never enter a receipt — the
 * `redactSecrets` helper scrubs them before any field is persisted.
 *
 * Status state machine:
 *   draft → assembled → submitted → confirmed
 *                              ↘  rejected
 *   draft / assembled can be abandoned (terminal → no further transitions).
 *
 * One receipt per run is the rule: the engine-level UNIQUE INDEX on
 * `run_id WHERE status IN ('draft','assembled','submitted','confirmed')`
 * refuses a second active receipt for the same run.
 */
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { contextReceiptRowSchema } from "./schema";
import { receiptStatusSchema, type ContextReceipt, type ReceiptStatus } from "../../shared/managed";
import { redactSecrets } from "./redact";
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

const RECEIPT_TRANSITIONS: Record<ReceiptStatus, ReadonlyArray<ReceiptStatus>> = {
  draft: ["assembled", "rejected"],
  assembled: ["submitted", "rejected"],
  submitted: ["confirmed", "rejected"],
  confirmed: [],
  rejected: [],
};

const assembleSchema = z.object({
  runId: z.string().uuid(),
  objective: z.string().min(1).max(8000),
  constraints: z.unknown().default({}),
  acceptanceChecks: z.unknown().default({}),
  selectedRevisions: z.unknown().default({}),
  instructions: z.unknown().default({}),
  environment: z.unknown().default({}),
  capabilities: z.unknown().default({}),
  exclusions: z.array(z.string().min(1).max(512)).default([]),
}).strict();
export type AssembleReceiptInput = z.input<typeof assembleSchema>;

export interface AssembledReceipt {
  readonly receipt: ContextReceipt;
  readonly objective: string;
  readonly selectedRevisionsJson: string;
  readonly instructionsJson: string;
  readonly environmentJson: string;
  readonly capabilitiesJson: string;
  readonly constraintsJson: string;
  readonly acceptanceChecksJson: string;
  readonly exclusionsJson: string;
  readonly digestsJson: string;
}

/**
 * Persist a new context receipt for a run. Every user-supplied field is
 * passed through `redactSecrets` first so a stray API key typed into the
 * objective never lands in storage. The returned `digestsJson` records
 * the SHA-256 of every redacted JSON payload so the receipt can prove
 * "these were the bytes I sent".
 */
export async function assembleContextReceipt(
  worker: DbWorker,
  input: AssembleReceiptInput,
): Promise<AssembledReceipt> {
  const parsed = assembleSchema.parse(input);
  const driver = driverOf(worker);
  const redactedObjective = redactSecrets(parsed.objective);
  const constraintsJson = JSON.stringify(redactSecrets(parsed.constraints));
  const acceptanceJson = JSON.stringify(redactSecrets(parsed.acceptanceChecks));
  const selectedJson = JSON.stringify(redactSecrets(parsed.selectedRevisions));
  const instructionsJson = JSON.stringify(redactSecrets(parsed.instructions));
  const environmentJson = JSON.stringify(redactSecrets(parsed.environment));
  const capabilitiesJson = JSON.stringify(redactSecrets(parsed.capabilities));
  const exclusionsJson = JSON.stringify(redactSecrets(parsed.exclusions));
  const digestsJson = JSON.stringify({
    objective: sha256(String(redactedObjective)),
    constraints: sha256(constraintsJson),
    acceptanceChecks: sha256(acceptanceJson),
    selectedRevisions: sha256(selectedJson),
    instructions: sha256(instructionsJson),
    environment: sha256(environmentJson),
    capabilities: sha256(capabilitiesJson),
    exclusions: sha256(exclusionsJson),
  });

  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const runExists = driver.prepare("SELECT uuid FROM run WHERE uuid = ?").first(parsed.runId);
    if (!runExists) throw new AppError("NOT_FOUND", "Run not found");
    // Enforce the one-active-receipt-per-run rule here (the schema also
    // carries a UNIQUE INDEX on `run_id`, but we surface a CONFLICT
    // before relying on the engine's error message).
    const existing = driver.prepare("SELECT uuid FROM context_receipt WHERE run_id = ?").first(parsed.runId);
    if (existing)
      throw new AppError("CONFLICT", `Run ${parsed.runId} already has a receipt`);
    try {
      driver.prepare(
        "INSERT INTO context_receipt (uuid, run_id, status, objective, constraints_json, " +
        "acceptance_checks_json, selected_revisions_json, instructions_json, " +
        "environment_json, capabilities_json, exclusions_json, digests_json, " +
        "created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id, parsed.runId, "draft",
        String(redactedObjective),
        constraintsJson, acceptanceJson, selectedJson, instructionsJson,
        environmentJson, capabilitiesJson, exclusionsJson, digestsJson,
        now, now,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE/.test(message))
        throw new AppError("CONFLICT", `Run ${parsed.runId} already has an active receipt`);
      throw error;
    }
  });
  const receipt = await readContextReceipt(worker, id);
  if (!receipt) throw new AppError("UNAVAILABLE", "Receipt disappeared after assemble");
  return {
    receipt,
    objective: String(redactedObjective),
    selectedRevisionsJson: selectedJson,
    instructionsJson,
    environmentJson,
    capabilitiesJson,
    constraintsJson,
    acceptanceChecksJson: acceptanceJson,
    exclusionsJson,
    digestsJson,
  };
}

export async function readContextReceipt(worker: DbWorker, id: string): Promise<ContextReceipt | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM context_receipt WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseReceiptRow(row);
}

export async function readActiveReceiptForRun(worker: DbWorker, runId: string): Promise<ContextReceipt | undefined> {
  const driver = driverOf(worker);
  // Pinned statuses applied as `OR` so the in-memory driver doesn't need
  // `IN (...)` (production `node:sqlite` would accept either).
  const row = driver.prepare(
    "SELECT * FROM context_receipt WHERE run_id = ? AND (status = 'draft' OR status = 'assembled' " +
    "OR status = 'submitted' OR status = 'confirmed') ORDER BY created_at DESC LIMIT 1",
  ).first(runId);
  return row ? parseReceiptRow(row) : undefined;
}

const TRANSITION_INPUT = z.object({
  to: receiptStatusSchema,
  by: z.string().min(1).max(256).optional(),
}).strict();
export type ReceiptTransitionInput = z.input<typeof TRANSITION_INPUT>;

export async function transitionContextReceipt(
  worker: DbWorker,
  id: string,
  input: ReceiptTransitionInput,
): Promise<ContextReceipt> {
  const parsed = TRANSITION_INPUT.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT status FROM context_receipt WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Receipt not found");
    const from = receiptStatusSchema.parse(String((row as Record<string, unknown>).status));
    if (!RECEIPT_TRANSITIONS[from].includes(parsed.to))
      throw new AppError("CONFLICT", `Illegal receipt transition ${from} → ${parsed.to}`);
    driver.prepare("UPDATE context_receipt SET status = ?, updated_at = ? WHERE uuid = ?")
      .run(parsed.to, new Date().toISOString(), id);
  });
  const after = await readContextReceipt(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Receipt disappeared after transition");
  return after;
}

function parseReceiptRow(row: Record<string, unknown>): ContextReceipt {
  const parsed = contextReceiptRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    runId: String(row.run_id),
    status: String(row.status),
    objective: String(row.objective),
    constraintsJson: String(row.constraints_json),
    acceptanceChecksJson: String(row.acceptance_checks_json),
    selectedRevisionsJson: String(row.selected_revisions_json),
    instructionsJson: String(row.instructions_json),
    environmentJson: String(row.environment_json),
    capabilitiesJson: String(row.capabilities_json),
    exclusionsJson: String(row.exclusions_json),
    digestsJson: String(row.digests_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}

function sha256(value: string): string {
  // Single hash per field; kept synchronous because the receipt is
  // assembled off the renderer's hot path.
  return createHash("sha256").update(value).digest("hex");
}