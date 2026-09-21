/**
 * M7.5 — pinned pricing catalog.
 *
 * The M7.5 spec bullet (FUTURE/IMPLEMENTATION-README.md lines 257-263)
 * requires:
 *
 *   > Show run/workflow history, deadlines, resource observations and
 *   > reported/estimated/unknown usage separately. Do not derive
 *   > human billable time from terminal uptime. Enforce spend only
 *   > through a verified provider/backend capability; otherwise show
 *   > estimate freshness + in-flight overshoot limits. Never silently
 *   > change billing mode or provider.
 *
 * `pricingCatalogSchema` is a JSON record persisted to `meta` under
 * the key `pricing:<tierDigest>:<providerVersion>`. The tier digest
 * is sha256 over the canonical price row (`stableStringify` excluding
 * `capturedAt` / `source`) so two providers that publish the same
 * prices produce the same digest and pin to the same audit row.
 *
 * The runtime never derives `costUsd` from `process.versions.icu` or
 * the host clock — it consults `resolvePricing(tierDigest,
 * providerVersion)` and multiplies tokens. A missing digest yields
 * `undefined` (no estimate, no silent fallback); the renderer shows
 * "estimated, last verified at <capturedAt>" + an explicit
 * freshness interval.
 *
 * Memory-driver portability: `meta` is the same range-scan table the
 * M7.3 boot-identity uses (`WHERE key >= ? AND key < ?`). The prefix
 * `pricing:` and the upper-bound `pricing;` keep the query portable.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Database } from "./types";

export const pricingCatalogSchema = z.object({
  tierDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: z.string().min(1).max(256),
  /** USD per million input tokens (cache-miss). */
  inputUsdPerMillion: z.number().nonnegative(),
  /** USD per million output tokens. */
  outputUsdPerMillion: z.number().nonnegative(),
  /** USD per million cache-read tokens (typically much cheaper). */
  cacheReadUsdPerMillion: z.number().nonnegative(),
  /** USD per million cache-write tokens. */
  cacheWriteUsdPerMillion: z.number().nonnegative(),
  /** ISO-8601 timestamp this row was captured. */
  capturedAt: z.string().datetime(),
  /**
   * Source label — `"manual"`, `"provider-published:<url>"`,
   * `"observed-burn:<provider>"`. Audit-only; not part of the
   * digest surface.
   */
  source: z.string().min(1).max(256),
}).strict();
export type PricingCatalogRow = z.output<typeof pricingCatalogSchema>;

/**
 * Caller-supplied input. `tierDigest` is optional — when omitted
 * the helper computes it from the canonical price surface. Supplying
 * a digest that does not match the computed one is refused.
 */
export const pricingCatalogInputSchema = pricingCatalogSchema.extend({
  tierDigest: pricingCatalogSchema.shape.tierDigest.optional(),
});
export type PricingCatalogInput = z.input<typeof pricingCatalogInputSchema>;

const META_KEY_PREFIX = "pricing:";
// Provider version strings can contain colons (e.g. `anthropic:1.0`)
// so the regex captures the provider version with `[^]+` after the
// first 64-hex digest segment. The range-scan upper bound keeps the
// query portable to the in-memory test driver.
const META_KEY_RE = /^pricing:([0-9a-f]{64}):(.+)$/;

function metaKey(tierDigest: string, providerVersion: string): string {
  return `${META_KEY_PREFIX}${tierDigest}:${providerVersion}`;
}

function metaUpperBound(): string {
  // `pricing:` followed by `;` sorts immediately after every
  // `pricing:<digest>:<provider>` row (digits and lowercase hex
  // both sort before `;`).
  return `${META_KEY_PREFIX.slice(0, -1)};`;
}

function rowKeyFor(tierDigest: string, providerVersion: string): string {
  return metaKey(tierDigest, providerVersion);
}

/**
 * Compute the canonical digest for a pricing catalog row. The
 * digest surface EXCLUDES `capturedAt` and `source` so a re-emitted
 * row with the same prices still hashes to the same tierDigest.
 */
export function digestPricingCatalog(row: PricingCatalogInput): string {
  // Strip fields not in the digest surface; sort keys via JSON
  // canonicalisation so insertion order doesn't matter.
  const { tierDigest: _t, capturedAt: _c, source: _s, ...rest } = row;
  void _t; void _c; void _s;
  // Use Node's deterministic JSON shape: stableStringify lives in
  // the effective-settings module — we can't import it without
  // creating a cycle (effective-settings depends on us transitively).
  // Inline the simple canonicalisation: sort object keys.
  return createHash("sha256").update(stableStringify(rest), "utf8").digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Pin (or replace) a pricing catalog row. The supplied `tierDigest`
 * is regenerated from the canonical surface so a caller can either
 * compute it ahead of time (and pass it back in the row) or omit it
 * and accept the computed value.
 *
 * Returns the persisted row's tier digest (sha256 hex).
 */
export function pinPricingCatalog(
  db: Database,
  row: PricingCatalogInput,
): { tierDigest: string } {
  // Pre-parse the input so optional fields (tierDigest) are
  // surfaced with their schema-enforced shape.
  const parsed = pricingCatalogInputSchema.parse(row);
  const computed = digestPricingCatalog(parsed);
  const persisted: PricingCatalogRow = {
    ...parsed,
    tierDigest: parsed.tierDigest ?? computed,
  };
  // Defensive: refuse a mismatch so a caller cannot pin a row under
  // a digest that doesn't match the prices.
  if (persisted.tierDigest !== computed) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ["tierDigest"],
        message:
          `pricing-catalog: supplied tierDigest ${persisted.tierDigest} does not match computed digest ${computed} from the canonical price surface`,
      },
    ]);
  }
  pricingCatalogSchema.parse(persisted);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
    .run(metaKey(persisted.tierDigest, persisted.providerVersion), JSON.stringify(persisted));
  return { tierDigest: persisted.tierDigest };
}

/**
 * Look up a pinned pricing row by tier digest + provider version.
 * Returns `undefined` when the row is not pinned — the renderer
 * surfaces "estimate, last verified at <…>" with a freshness
 * warning; the runtime NEVER silently substitutes a different
 * tier.
 */
export function resolvePricing(
  db: Database,
  tierDigest: string,
  providerVersion: string,
): PricingCatalogRow | undefined {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .first(rowKeyFor(tierDigest, providerVersion)) as { value: string } | undefined;
  if (!row) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(row.value) as unknown; }
  catch { return undefined; }
  const result = pricingCatalogSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

/**
 * List every pinned pricing catalog row (for the renderer's
 * "view catalog" affordance). Returns rows sorted by
 * `capturedAt` descending.
 */
export function listPricingCatalog(db: Database): PricingCatalogRow[] {
  const rows = db
    .prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?")
    .all(META_KEY_PREFIX, metaUpperBound()) as Array<{ key: string; value: string }>;
  const out: PricingCatalogRow[] = [];
  for (const row of rows) {
    const match = row.key.match(META_KEY_RE);
    if (!match) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(row.value) as unknown; }
    catch { continue; }
    const result = pricingCatalogSchema.safeParse(parsed);
    if (result.success) out.push(result.data);
  }
  out.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0));
  return out;
}

/**
 * Convert observed token counts to USD using a pinned pricing row.
 * Returns `null` when the digest is unknown (the renderer surfaces
 * "estimate, unknown tier" rather than silently picking a row).
 *
 * Token counts that are `null` (provider didn't report) contribute
 * 0 — partial observations are accepted.
 */
export function costFromPricing(
  row: PricingCatalogRow | undefined,
  tokens: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly cacheReadTokens: number | null;
    readonly cacheWriteTokens: number | null;
  },
): number | null {
  if (!row) return null;
  const usd =
    ((tokens.inputTokens ?? 0) * row.inputUsdPerMillion) / 1_000_000 +
    ((tokens.outputTokens ?? 0) * row.outputUsdPerMillion) / 1_000_000 +
    ((tokens.cacheReadTokens ?? 0) * row.cacheReadUsdPerMillion) / 1_000_000 +
    ((tokens.cacheWriteTokens ?? 0) * row.cacheWriteUsdPerMillion) / 1_000_000;
  // Round to cents (USD). Two-decimal precision is enough for the
  // observation surface; cents-level rounding prevents drift on
  // repeated runs of the same token count.
  return Math.round(usd * 100) / 100;
}
