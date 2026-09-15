/**
 * M4.2 — Provider profile model.
 *
 * A "provider profile" binds a runtime identity (provider, account
 * mode, scopes) to a stable, non-secret handle. Profiles are
 * referenced by run + recipe + capability manifests, not embedded —
 * so a profile can be updated (or revoked) without rewriting every
 * run that references it.
 *
 * Storage:
 *  - definitions live in the `meta` table under
 *    `provider-profile:<profileId>` carrying a small JSON payload;
 *  - activations live in the same table under
 *    `provider-profile-active:<provider>` (at most one active
 *    profile per provider, enforced by the writer).
 *
 * Definition vs. activation:
 *  - **Definition** (`defineProviderProfile`) records the profile
 *    shape but does not change runtime behaviour. A defined profile
 *    is an inert record.
 *  - **Activation** (`activateProviderProfile`) flips the
 *    per-provider active marker so a future run, recipe or
 *    capability can resolve the active profile by provider. There is
 *    always at most one active profile per provider.
 *
 * The M4.2 increment is the read + definition + activation surface.
 * Secret material (API keys, OAuth tokens, login-store references)
 * is never stored in this module — M4.2's roadmap line is explicit:
 * "Do not rewrite global instructions or provider login stores."
 * Future provider adapters can read their own login stores through
 * the OS-provided paths; the runtime never copies them into
 * provider-profile rows.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";

export const PROVIDER_PROFILE_META_PREFIX = "provider-profile:";
export const PROVIDER_PROFILE_ACTIVE_META_PREFIX = "provider-profile-active:";

/** Supported provider identities. M4.1 added the second. */
export const providerProfileProviderSchema = z.enum(["claude", "codex"]);
export type ProviderProfileProvider = z.infer<typeof providerProfileProviderSchema>;

/** Supported account modes. Mirrors M3b's `SpawnRequest.accountMode`. */
export const providerProfileAccountModeSchema = z.enum([
  "anonymous",
  "authenticated",
  "trusted-host",
]);
export type ProviderProfileAccountMode = z.infer<typeof providerProfileAccountModeSchema>;

/**
 * Profile shape. Note the absence of any secret field — the model
 * holds identity, mode, and **scope** (a list of capability grants
 * the profile authorises), not credentials. Secret material lives in
 * the provider's own login store.
 */
export const providerProfileSchema = z
  .object({
    profileId: z.string().uuid(),
    provider: providerProfileProviderSchema,
    accountMode: providerProfileAccountModeSchema,
    displayName: z.string().trim().min(1).max(80),
    /** Capability grants the profile authorises. Empty is allowed (least-privilege default). */
    scopes: z.array(z.string().min(1).max(80)).max(64).default([]),
    /** ISO-8601 timestamp the profile was defined. */
    definedAt: z.string().datetime(),
    /** ISO-8601 timestamp the profile was last activated, if any. */
    activatedAt: z.string().datetime().nullable().default(null),
    /** Free-form notes the user attached (no secret material). */
    notes: z.string().max(4096).default(""),
  })
  .strict();
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

/** Result of a definition or activation. */
export interface ProviderProfileMutation {
  readonly profile: ProviderProfile;
  readonly active: boolean;
  readonly metaKey: string;
}

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
  transaction<T>(fn: (tx: unknown) => T): T;
}

function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

function definitionKey(profileId: string): string {
  return `${PROVIDER_PROFILE_META_PREFIX}${profileId}`;
}
function activeKey(provider: ProviderProfileProvider): string {
  return `${PROVIDER_PROFILE_ACTIVE_META_PREFIX}${provider}`;
}

function parseStoredJson<T>(key: string, raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new AppError(
      "IO_ERROR",
      `Provider profile at "${key}" is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AppError(
      "CONFLICT",
      `Provider profile at "${key}" failed validation: ${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Read a single profile by id. Returns `null` when the row is
 * absent; raises `AppError("CONFLICT", …)` when the row exists but
 * is malformed (so the renderer can distinguish "not defined" from
 * "defined but corrupt").
 */
export async function readProviderProfile(
  worker: DbWorker,
  profileId: string,
): Promise<ProviderProfile | null> {
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT value FROM meta WHERE key = ?`).first(definitionKey(profileId));
  if (!row) return null;
  const raw = String(row.value ?? "");
  return parseStoredJson(definitionKey(profileId), raw, providerProfileSchema);
}

/**
 * Read the active profile for a provider. Returns `null` when no
 * profile is currently active.
 */
export async function readActiveProviderProfile(
  worker: DbWorker,
  provider: ProviderProfileProvider,
): Promise<ProviderProfile | null> {
  const driver = driverOf(worker);
  const row = driver.prepare(`SELECT value FROM meta WHERE key = ?`).first(activeKey(provider));
  if (!row) return null;
  const raw = String(row.value ?? "");
  // The active row stores the profile id; we re-read the definition.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof (parsed as { profileId?: unknown }).profileId !== "string") {
    return null;
  }
  return readProviderProfile(worker, (parsed as { profileId: string }).profileId);
}

/**
 * Define a new provider profile (or overwrite an existing one with
 * the same id). The definition row is written inside a transaction;
 * activation is **not** performed here — callers must call
 * `activateProviderProfile` separately.
 */
export async function defineProviderProfile(
  worker: DbWorker,
  input: Omit<ProviderProfile, "activatedAt">,
): Promise<ProviderProfileMutation> {
  const profile = providerProfileSchema.parse({
    ...input,
    activatedAt: null,
  });
  const payload = JSON.stringify(profile);
  const driver = driverOf(worker);
  driver.transaction(() => {
    // Upsert via INSERT OR REPLACE — the `meta` table key is the
    // primary key, so duplicate keys replace the prior row.
    driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(definitionKey(profile.profileId), payload);
  });
  return { profile, active: false, metaKey: definitionKey(profile.profileId) };
}

/**
 * Activate a profile. The activation is recorded both in the
 * profile's `activatedAt` field and in the per-provider active
 * marker. Activation is **idempotent** — calling
 * `activateProviderProfile(worker, profile)` twice is the same as
 * calling it once; the second call updates `activatedAt` but leaves
 * the active marker pointing at the same profile.
 *
 * Activation refuses when the profile does not exist; the runtime
 * never silently materialises an undefined profile.
 */
export async function activateProviderProfile(
  worker: DbWorker,
  profileId: string,
): Promise<ProviderProfileMutation> {
  const existing = await readProviderProfile(worker, profileId);
  if (!existing) {
    throw new AppError(
      "NOT_FOUND",
      `Cannot activate unknown provider profile "${profileId}"`,
    );
  }
  const activated: ProviderProfile = { ...existing, activatedAt: new Date().toISOString() };
  const driver = driverOf(worker);
  driver.transaction(() => {
    // Update the definition row with the new activatedAt.
    driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(definitionKey(profileId), JSON.stringify(activated));
    // Flip the per-provider active marker.
    driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(activeKey(existing.provider), JSON.stringify({ profileId }));
  });
  return { profile: activated, active: true, metaKey: activeKey(existing.provider) };
}

/**
 * Clear the active marker for a provider without deleting any
 * profile definitions. Returns the previously-active profile (if
 * any) so the caller can audit what was revoked.
 */
export async function deactivateProviderProfile(
  worker: DbWorker,
  provider: ProviderProfileProvider,
): Promise<ProviderProfile | null> {
  const previous = await readActiveProviderProfile(worker, provider);
  const driver = driverOf(worker);
  driver.transaction(() => {
    driver.prepare(`DELETE FROM meta WHERE key = ?`).run(activeKey(provider));
  });
  return previous;
}

/**
 * List all defined profiles. Does **not** surface activation state;
 * callers can compose with `readActiveProviderProfile` per provider.
 *
 * Implementation note: the in-memory test driver does not implement
 * the `LIKE` predicate, and a SQLite-side prefix match would still
 * need a JS post-filter for `nativeFields` validation. We iterate
 * the `meta` table client-side instead — the table is small
 * (one row per profile, plus a handful of unrelated keys), so this
 * is acceptable for M4.2. A future increment can switch to a
 * dedicated `provider_profile` table if listing grows expensive.
 */
export async function listProviderProfiles(
  worker: DbWorker,
): Promise<ProviderProfile[]> {
  const driver = driverOf(worker);
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const out: ProviderProfile[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(PROVIDER_PROFILE_META_PREFIX)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      const result = providerProfileSchema.safeParse(parsed);
      if (result.success) out.push(result.data);
    } catch {
      // Skip malformed rows — listing must not throw on a corrupt row.
    }
  }
  // Stable order by profileId for deterministic listing.
  return out.sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
}
