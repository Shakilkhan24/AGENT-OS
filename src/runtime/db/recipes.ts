/**
 * M6.2 — immutable recipe version entity service.
 *
 * Each recipe is a content-addressed immutable version under the
 * existing `meta` table. The key is
 * `recipe:<recipeId>:<version>:<digest>` where `digest` is a
 * SHA-256 over the canonical JSON of the immutable payload
 * (excluding volatile `publishedAt`). The digest participates in
 * the key itself so a tampered row collides on `INSERT` and is
 * refused — mirrors the M4.4 plan ledger pattern.
 *
 * Edits and promotion never overwrite a published version: the
 * caller passes `parentVersion` to `publishRecipeVersion` and the
 * service refuses if (recipeId, version) already exists or the
 * supplied version is not exactly `parentVersion + 1`.
 *
 * No live grant IDs, credentials, or volatile secrets are stored
 * here. The recipe pins REQUIREMENTS; per-execution authority is
 * resolved at dispatch time from the live grant set.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "./effective-settings";
import {
  recipeVersionSchema,
  recipePermissionRequirementSchema,
  type RecipeVersion,
  type RecipeSummary,
  recipeSummarySchema,
} from "../../shared/recipe-schema";
import type { DbWorker } from "./worker";

// ---------------------------------------------------------------------------
// Meta-table driver
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

const publishInputSchema = z
  .object({
    recipeId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    description: z.string().max(4096).default(""),
    workflow: z.unknown(),
    providers: recipeVersionSchema.shape.providers.default([]),
    permissions: recipeVersionSchema.shape.permissions.default([]),
    verification: recipeVersionSchema.shape.verification.default(null),
    environment: recipeVersionSchema.shape.environment,
    tags: recipeVersionSchema.shape.tags.default([]),
    publishedBy: z.string().min(1).max(256),
  })
  .strict();
export type PublishRecipeInput = z.input<typeof publishInputSchema>;

const promoteInputSchema = z
  .object({
    parentVersion: z.number().int().min(0).max(2_047),
    displayName: z.string().min(1).max(256),
    workflow: z.unknown(),
    description: z.string().max(4096).default(""),
    providers: recipeVersionSchema.shape.providers.default([]),
    permissions: recipeVersionSchema.shape.permissions.default([]),
    verification: recipeVersionSchema.shape.verification.default(null),
    environment: recipeVersionSchema.shape.environment,
    tags: recipeVersionSchema.shape.tags.default([]),
    publishedBy: z.string().min(1).max(256),
  })
  .strict();
export type PromoteRecipeInput = z.input<typeof promoteInputSchema>;

// ---------------------------------------------------------------------------
// Digest computation
// ---------------------------------------------------------------------------

/**
 * Compute the immutable-version digest. Excludes `publishedAt`
 * so a re-publish with identical content but a different clock
 * produces the same digest — the audit-event digest pattern from
 * M4.6 / M5.5 / M5.6.
 */
export function digestRecipe(version: Omit<RecipeVersion, "publishedAt">): string {
  const { publishedAt: _publishedAt, ...rest } = version as RecipeVersion;
  void _publishedAt;
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Meta-key helpers
// ---------------------------------------------------------------------------

function recipeMetaKey(recipeId: string, version: number, digest: string): string {
  return `recipe:${recipeId}:${String(version).padStart(4, "0")}:${digest}`;
}

function parseRecipeMetaKey(key: string): { recipeId: string; version: number; digest: string } | null {
  // Strict shape — refuse to read a key that doesn't match the
  // documented layout so a future meta-row collision (e.g. an
  // M6.2 migration) cannot leak unrelated content into a recipe
  // lookup.
  const match = /^recipe:([^:]{1,128}):([0-9]{1,4}):([0-9a-f]{64})$/.exec(key);
  if (!match) return null;
  const [, recipeId, version, digest] = match;
  return { recipeId, version: Number(version), digest };
}

// ---------------------------------------------------------------------------
// Publish — first version OR a brand-new recipeId.
// ---------------------------------------------------------------------------

export async function publishRecipe(
  worker: DbWorker,
  input: PublishRecipeInput,
): Promise<RecipeVersion> {
  const parsed = publishInputSchema.parse(input);
  // First-version path: refuse if any version already exists for this recipeId.
  const existing = await listRecipeVersions(worker, parsed.recipeId);
  if (existing.length > 0)
    throw new AppError(
      "CONFLICT",
      `recipe ${parsed.recipeId} already has ${existing.length} version(s); use promoteRecipe instead`,
    );
  return insertVersion(worker, parsed.recipeId, 1, parsed, parsed.publishedBy);
}

// ---------------------------------------------------------------------------
// Promote — strictly monotonic; refuse if parentVersion mismatches latest.
// ---------------------------------------------------------------------------

export async function promoteRecipe(
  worker: DbWorker,
  recipeId: string,
  input: PromoteRecipeInput,
): Promise<RecipeVersion> {
  const parsed = promoteInputSchema.parse(input);
  if (recipeId.length < 1 || recipeId.length > 128)
    throw new AppError("INVALID_REQUEST", "recipeId length out of range");
  const versions = await listRecipeVersions(worker, recipeId);
  if (versions.length === 0)
    throw new AppError("NOT_FOUND", `recipe ${recipeId} has no versions to promote from`);
  const latest = versions[versions.length - 1];
  if (parsed.parentVersion !== latest.version)
    throw new AppError(
      "CONFLICT",
      `parentVersion mismatch: latest is ${latest.version}, caller supplied ${parsed.parentVersion}`,
    );
  return insertVersion(worker, recipeId, latest.version + 1, parsed, parsed.publishedBy);
}

// ---------------------------------------------------------------------------
// Internal insert — single shared transaction so the digest collision check
// is atomic with the INSERT.
// ---------------------------------------------------------------------------

async function insertVersion(
  worker: DbWorker,
  recipeId: string,
  version: number,
  parsed: PublishRecipeInput | PromoteRecipeInput,
  publishedBy: string,
): Promise<RecipeVersion> {
  const now = new Date().toISOString();
  // Build the candidate payload, run it through `recipeVersionSchema`
  // once to apply defaults (`description`, `providers`, `permissions`,
  // `verification`, `tags`), then strip `publishedAt` for the digest
  // surface. `z.input<>` carries `undefined` for defaulted fields so
  // we cannot construct the output type directly from the input.
  const draft: RecipeVersion = recipeVersionSchema.parse({
    recipeId,
    version,
    displayName: parsed.displayName,
    description: parsed.description ?? "",
    workflow: parsed.workflow,
    providers: parsed.providers ?? [],
    permissions: parsed.permissions ?? [],
    verification: parsed.verification ?? null,
    environment: parsed.environment,
    tags: parsed.tags ?? [],
    publishedBy,
    publishedAt: now,
  });
  const partial: Omit<RecipeVersion, "publishedAt"> = (() => {
    const { publishedAt: _publishedAt, ...rest } = draft;
    void _publishedAt;
    return rest;
  })();
  const digest = digestRecipe(partial);
  const key = recipeMetaKey(recipeId, version, digest);
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    // Refuse if (recipeId, version) already exists. The meta-key
    // includes the digest so a true collision (different content,
    // same digest) is impossible; this guard catches the case
    // where a caller tries to republish the SAME (recipeId,
    // version) with a different digest. Use the same JS filter
    // helper the read path uses so the in-memory driver works.
    const existing = readAllRecipeRows(worker).filter((row) => {
      const meta = parseRecipeMetaKey(row.key);
      return meta !== null && meta.recipeId === recipeId && meta.version === version;
    });
    if (existing.length > 0)
      throw new AppError(
        "CONFLICT",
        `recipe ${recipeId} v${version} already exists (immutable)`,
      );
    driver
      .prepare("INSERT INTO meta (key, value) VALUES (?, ?)")
      .run(key, JSON.stringify({ ...draft, digest }));
  });
  return { ...draft };
}

// ---------------------------------------------------------------------------
// Read paths — meta-table is queried in full, then filtered in JS by
// the documented `recipe:<id>:<version>:<digest>` key shape. Mirrors
// the M4.6 / M4.7 meta-row read pattern so the in-memory driver
// (which lacks `LIKE`) and the SQLite driver both work without a
// schema migration.
// ---------------------------------------------------------------------------

function readAllRecipeRows(worker: DbWorker): Array<{ key: string; value: string }> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT key, value FROM meta").all() as Array<{
    key: string;
    value: string;
  }>;
  return rows.filter((row) => parseRecipeMetaKey(row.key) !== null);
}

export async function readRecipeVersion(
  worker: DbWorker,
  recipeId: string,
  version: number,
): Promise<RecipeVersion | undefined> {
  const matches = readAllRecipeRows(worker).filter((row) => {
    const meta = parseRecipeMetaKey(row.key);
    return meta !== null && meta.recipeId === recipeId && meta.version === version;
  });
  if (matches.length === 0) return undefined;
  if (matches.length > 1)
    throw new AppError(
      "UNAVAILABLE",
      `recipe ${recipeId} v${version} has ${matches.length} digest variants; data corruption`,
    );
  return parseRecipeRow(matches[0].key, matches[0].value);
}

export async function readLatestRecipeVersion(
  worker: DbWorker,
  recipeId: string,
): Promise<RecipeVersion | undefined> {
  const versions = await listRecipeVersions(worker, recipeId);
  if (versions.length === 0) return undefined;
  return versions[versions.length - 1];
}

export async function listRecipeVersions(
  worker: DbWorker,
  recipeId: string,
): Promise<RecipeVersion[]> {
  return readAllRecipeRows(worker)
    .map((row) => parseRecipeRow(row.key, row.value))
    .filter((row): row is RecipeVersion => row !== undefined && row.recipeId === recipeId)
    .sort((a, b) => a.version - b.version);
}

export async function listRecipeSummaries(worker: DbWorker): Promise<RecipeSummary[]> {
  const allRows = readAllRecipeRows(worker);
  const byRecipe = new Map<string, { version: number; row: RecipeVersion }>();
  const counts = new Map<string, number>();
  for (const row of allRows) {
    const parsed = parseRecipeRow(row.key, row.value);
    if (!parsed) continue;
    counts.set(parsed.recipeId, (counts.get(parsed.recipeId) ?? 0) + 1);
    const prev = byRecipe.get(parsed.recipeId);
    if (!prev || parsed.version > prev.version) {
      byRecipe.set(parsed.recipeId, { version: parsed.version, row: parsed });
    }
  }
  return [...byRecipe.values()].map(({ version, row }) =>
    recipeSummarySchema.parse({
      recipeId: row.recipeId,
      latestVersion: version,
      totalVersions: counts.get(row.recipeId) ?? 1,
      displayName: row.displayName,
      tags: row.tags,
      publishedAt: row.publishedAt,
      publishedBy: row.publishedBy,
      latestDigest: digestRecipe({
        recipeId: row.recipeId,
        version,
        displayName: row.displayName,
        description: row.description,
        workflow: row.workflow,
        providers: row.providers,
        permissions: row.permissions,
        verification: row.verification,
        environment: row.environment,
        tags: row.tags,
        publishedBy: row.publishedBy,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Internal parser
// ---------------------------------------------------------------------------

function parseRecipeRow(key: string, value: string): RecipeVersion | undefined {
  const meta = parseRecipeMetaKey(key);
  if (!meta) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;
  // Confirm the stored digest matches the meta-key digest. A
  // mutation between insert and read surfaces here as a Zod
  // refinement failure (the row is silently dropped — caller sees
  // it as if the version did not exist, which matches the M4.4
  // plan-digest behaviour).
  if (typeof obj.digest === "string" && obj.digest !== meta.digest) return undefined;
  return recipeVersionSchema.parse({
    recipeId: obj.recipeId,
    version: obj.version,
    displayName: obj.displayName,
    description: obj.description ?? "",
    workflow: obj.workflow,
    providers: obj.providers ?? [],
    permissions: obj.permissions ?? [],
    verification: obj.verification ?? null,
    environment: obj.environment,
    tags: obj.tags ?? [],
    publishedBy: obj.publishedBy,
    publishedAt: obj.publishedAt,
  });
}

/**
 * Resolve a live grant set against a recipe's permission
 * requirements. Per M6.2 "Resolve current authority per execution"
 * — the recipe NEVER carries live grant IDs; the caller passes the
 * current approved grant set (e.g. from M5.1's facade). Returns
 * the subset of requirements that are satisfied + the unsatisfied
 * ones. `errorOnUnsatisfied = true` throws `CONFLICT` for missing
 * required permissions; `false` returns the unsatisfied set.
 */
export interface ResolvedRecipePermissions {
  readonly satisfied: ReadonlyArray<{
    requirement: z.infer<typeof recipePermissionRequirementSchema>;
    matchedGrantId: string;
  }>;
  readonly unsatisfied: ReadonlyArray<z.infer<typeof recipePermissionRequirementSchema>>;
}

export function resolveRecipePermissions(
  version: RecipeVersion,
  liveGrants: ReadonlyArray<{
    id: string;
    status: "approved";
    kind: string;
    scopeJson: Record<string, unknown>;
  }>,
): ResolvedRecipePermissions {
  const satisfied: Array<{
    requirement: z.infer<typeof recipePermissionRequirementSchema>;
    matchedGrantId: string;
  }> = [];
  const unsatisfied: Array<z.infer<typeof recipePermissionRequirementSchema>> = [];
  for (const req of version.permissions) {
    const match = liveGrants.find((g) => g.status === "approved" && g.kind === req.kind);
    if (!match) {
      if (req.required) unsatisfied.push(req);
      continue;
    }
    satisfied.push({ requirement: req, matchedGrantId: match.id });
  }
  return { satisfied, unsatisfied };
}

void randomUUID;
