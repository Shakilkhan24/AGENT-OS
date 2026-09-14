/**
 * M3c.2 — `verification_recipe` entity service.
 *
 * A recipe is per-project configuration that names a verifier command,
 * its argv/env tail, an optional JSON-line assertion pattern, and
 * whether the recipe is `required`. Recipes are stable configuration:
 * the runtime never edits a recipe implicitly; only the user / IPC layer
 * does (and that goes through `updateRecipe` so the
 * `configuration_revision` SHA-256 is recomputed and the binding a
 * `review` carries is invalidated by the next verifier run).
 *
 * The configuration revision is computed by `computeConfigurationRevision`
 * — a single deterministic SHA-256 of `(command + argv + env +
 * assertionPattern + required)`. This is what the review binds to:
 * "the user accepted the candidate under this exact configuration".
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { verificationRecipeRowSchema } from "./schema";
import type { VerificationRecipe } from "../../shared/managed";
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

const createRecipeSchema = z.object({
  projectId: z.string().min(1).max(256),
  name: z.string().trim().min(1).max(200),
  command: z.string().trim().min(1).max(1024),
  argv: z.array(z.string().min(1).max(1024)).default([]),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
  assertionPattern: z.string().max(256).nullable().default(null),
  required: z.boolean().default(true),
}).strict();
export type CreateRecipeInput = z.input<typeof createRecipeSchema>;

const updateRecipeSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  command: z.string().trim().min(1).max(1024).optional(),
  argv: z.array(z.string().min(1).max(1024)).optional(),
  env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).optional(),
  assertionPattern: z.string().max(256).nullable().optional(),
  required: z.boolean().optional(),
}).strict();
export type UpdateRecipeInput = z.input<typeof updateRecipeSchema>;

/**
 * Compute the recipe's configuration revision. Pure: same input → same
 * SHA-256. The runtime uses the digest as the binding key for reviews;
 * a recipe edit bumps the digest and invalidates any in-flight `open`
 * review (see `invalidateOpenReviewsForRun`).
 */
export function computeConfigurationRevision(input: {
  command: string;
  argv: ReadonlyArray<string>;
  env: Readonly<Record<string, string>>;
  assertionPattern: string | null;
  required: boolean;
}): string {
  const sortedEnv = Object.fromEntries(
    Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
  );
  const canonical = JSON.stringify({
    command: input.command,
    argv: [...input.argv],
    env: sortedEnv,
    assertionPattern: input.assertionPattern,
    required: input.required,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export async function createRecipe(worker: DbWorker, input: CreateRecipeInput): Promise<VerificationRecipe> {
  const parsed = createRecipeSchema.parse(input);
  const configurationRevision = computeConfigurationRevision({
    command: parsed.command,
    argv: parsed.argv,
    env: parsed.env,
    assertionPattern: parsed.assertionPattern,
    required: parsed.required,
  });
  const driver = driverOf(worker);
  const id = randomUUID();
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO verification_recipe (uuid, project_id, name, command, argv_json, env_json, " +
      "assertion_pattern, required, configuration_revision, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id, parsed.projectId, parsed.name, parsed.command,
      JSON.stringify(parsed.argv),
      JSON.stringify(parsed.env),
      parsed.assertionPattern,
      parsed.required ? 1 : 0,
      configurationRevision, now, now,
    );
  });
  const read = await readRecipe(worker, id);
  if (!read) throw new AppError("UNAVAILABLE", "Recipe disappeared after insert");
  return read;
}

export async function readRecipe(worker: DbWorker, id: string): Promise<VerificationRecipe | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT * FROM verification_recipe WHERE uuid = ?").first(id);
  if (!row) return undefined;
  return parseRecipeRow(row);
}

export async function listRecipesForProject(worker: DbWorker, projectId: string): Promise<VerificationRecipe[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare(
    "SELECT * FROM verification_recipe WHERE project_id = ? ORDER BY created_at ASC",
  ).all(projectId);
  return rows.map(parseRecipeRow);
}

/** Flat list — used by the projection. */
export async function listRecipes(worker: DbWorker): Promise<VerificationRecipe[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT * FROM verification_recipe ORDER BY created_at ASC").all();
  return rows.map(parseRecipeRow);
}

export async function updateRecipe(worker: DbWorker, id: string, input: UpdateRecipeInput): Promise<VerificationRecipe> {
  const parsed = updateRecipeSchema.parse(input);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT * FROM verification_recipe WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Recipe not found");
    const existing = parseRecipeRow(row);
    const merged: VerificationRecipe = {
      ...existing,
      ...(parsed.name !== undefined ? { name: parsed.name } : {}),
      ...(parsed.command !== undefined ? { command: parsed.command } : {}),
      ...(parsed.argv !== undefined ? { argvJson: JSON.stringify(parsed.argv) } : {}),
      ...(parsed.env !== undefined ? { envJson: JSON.stringify(parsed.env) } : {}),
      ...(parsed.assertionPattern !== undefined ? { assertionPattern: parsed.assertionPattern } : {}),
      ...(parsed.required !== undefined ? { required: parsed.required } : {}),
      updatedAt: new Date().toISOString(),
    };
    // Recompute the configuration revision off the merged fields so the
    // digest reflects whatever the user just saved.
    const configurationRevision = computeConfigurationRevision({
      command: merged.command,
      argv: JSON.parse(merged.argvJson) as ReadonlyArray<string>,
      env: JSON.parse(merged.envJson) as Readonly<Record<string, string>>,
      assertionPattern: merged.assertionPattern,
      required: merged.required,
    });
    driver.prepare(
      "UPDATE verification_recipe SET name = ?, command = ?, argv_json = ?, env_json = ?, " +
      "assertion_pattern = ?, required = ?, configuration_revision = ?, updated_at = ? " +
      "WHERE uuid = ?",
    ).run(
      merged.name, merged.command, merged.argvJson, merged.envJson,
      merged.assertionPattern, merged.required ? 1 : 0,
      configurationRevision, merged.updatedAt, id,
    );
  });
  const after = await readRecipe(worker, id);
  if (!after) throw new AppError("UNAVAILABLE", "Recipe disappeared after update");
  return after;
}

export async function deleteRecipe(worker: DbWorker, id: string): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    const row = driver.prepare("SELECT uuid FROM verification_recipe WHERE uuid = ?").first(id);
    if (!row) throw new AppError("NOT_FOUND", "Recipe not found");
    driver.prepare("DELETE FROM verification_recipe WHERE uuid = ?").run(id);
  });
}

function parseRecipeRow(row: Record<string, unknown>): VerificationRecipe {
  const parsed = verificationRecipeRowSchema.parse({
    uuid: String(row.uuid),
    id: String(row.uuid),
    projectId: String(row.project_id ?? ""),
    name: String(row.name),
    command: String(row.command),
    argvJson: String(row.argv_json ?? "[]"),
    envJson: String(row.env_json ?? "{}"),
    assertionPattern: row.assertion_pattern == null ? null : String(row.assertion_pattern),
    required: Number(row.required ?? 0) === 1,
    configurationRevision: String(row.configuration_revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
  return { ...parsed, id: parsed.uuid };
}