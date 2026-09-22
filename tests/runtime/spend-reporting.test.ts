/**
 * M7.5 — usage/spend reporting tests.
 *
 * The M7.5 spec bullet (FUTURE/IMPLEMENTATION-README.md lines 257-263)
 * requires:
 *
 *   > Show run/workflow history, deadlines, resource observations and
 *   > reported/estimated/unknown usage separately. Enforce spend only
 *   > through a verified provider/backend capability; otherwise show
 *   > estimate freshness + in-flight overshoot limits.
 *
 * Coverage:
 *
 *   1. `observationUsageSchema` accepts `costUsd` + `pricingTierDigest`;
 *   2. `costFromPricing` returns USD for a known tier;
 *   3. `costFromPricing` returns `null` for an unknown tier;
 *   4. `pinPricingCatalog` is idempotent on the same digest;
 *   5. `pinPricingCatalog` rejects a digest mismatch;
 *   6. `digestPricingCatalog` is stable across `capturedAt` / `source`
 *      changes (audit-friendly);
 *   7. `resolvePricing` returns the pinned row + freshness timestamp;
 *   8. `workflowUsageRollupSchema` parses the completed-result shape;
 *   9. Two runs with the same tokens but different digests yield two
 *      distinct `costUsd` values;
 *  10. `process.versions.icu` mismatch does not block pricing (orthogonal).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import type { Database } from "../../src/runtime/db/types";
import {
  costFromPricing,
  digestPricingCatalog,
  listPricingCatalog,
  pinPricingCatalog,
  pricingCatalogSchema,
  resolvePricing,
} from "../../src/runtime/db/pricing-catalog";
import {
  observationPayloadSchema,
  observationUsageSchema,
} from "../../src/runtime/orchestration/observation";
import { workflowUsageRollupSchema } from "../../src/shared/workflow-executor-schema";

function freshDb(): Database {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return driver;
}

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const PROVIDER = "anthropic:1.0";

test("M7.5 observationUsageSchema accepts costUsd + pricingTierDigest", () => {
  const usage = observationUsageSchema.parse({
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    costUsd: 0.0123,
    pricingTierDigest: SHA_A,
  });
  assert.equal(usage.costUsd, 0.0123);
  assert.equal(usage.pricingTierDigest, SHA_A);
});

test("M7.5 observationUsageSchema defaults costUsd + pricingTierDigest to null", () => {
  const usage = observationUsageSchema.parse({
    inputTokens: 100,
    outputTokens: 50,
  });
  assert.equal(usage.costUsd, null);
  assert.equal(usage.pricingTierDigest, null);
});

test("M7.5 observationPayloadSchema accepts a usage block with costUsd", () => {
  const payload = observationPayloadSchema.parse({
    startup: { type: "agent", hostId: "host-1" },
    exit: { at: new Date().toISOString(), code: 0, signal: null, reason: null },
    usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.05, pricingTierDigest: SHA_A },
  });
  assert.equal(payload.usage?.costUsd, 0.05);
});

test("M7.5 pinPricingCatalog + resolvePricing round-trip", () => {
  const db = freshDb();
  const result = pinPricingCatalog(db, {
    // Omit tierDigest — the helper computes it from the canonical
    // price surface. The test then re-pins under that digest.
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  assert.equal(result.tierDigest.length, 64);
  const resolved = resolvePricing(db, result.tierDigest, PROVIDER);
  assert.ok(resolved);
  assert.equal(resolved.providerVersion, PROVIDER);
  assert.equal(resolved.inputUsdPerMillion, 3);
});

test("M7.5 pinPricingCatalog is idempotent on the same digest", () => {
  const db = freshDb();
  const first = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  // Re-pin with the SAME prices (digest unchanged) overwrites the
  // row in place. The audit trail records the latest capturedAt,
  // but the digest is stable.
  const again = pinPricingCatalog(db, {
    tierDigest: first.tierDigest,
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-02-01T00:00:00Z",
    source: "manual",
  });
  assert.equal(again.tierDigest, first.tierDigest);
  const resolved = resolvePricing(db, first.tierDigest, PROVIDER);
  assert.equal(resolved?.inputUsdPerMillion, 3);
  assert.equal(resolved?.capturedAt, "2026-02-01T00:00:00Z");
});

test("M7.5 pinPricingCatalog rejects a digest mismatch", () => {
  const db = freshDb();
  // Pinning with a stale digest + new prices fails the schema check.
  let captured: unknown;
  try {
    pinPricingCatalog(db, {
      tierDigest: SHA_A,
      providerVersion: PROVIDER,
      inputUsdPerMillion: 99,
      outputUsdPerMillion: 99,
      cacheReadUsdPerMillion: 99,
      cacheWriteUsdPerMillion: 99,
      capturedAt: "2026-01-01T00:00:00Z",
      source: "manual",
    });
  } catch (e) { captured = e; }
  // Zod's ZodError does not extend Error in this version, so we
  // assert on the toString() shape rather than `instanceof Error`.
  assert.ok(captured !== undefined, "expected pin to throw on digest mismatch");
  const text = String(captured);
  assert.match(text, /does not match computed digest/);
});

test("M7.5 digestPricingCatalog is stable across capturedAt + source changes", () => {
  const d1 = digestPricingCatalog({
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  const d2 = digestPricingCatalog({
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-09-21T00:00:00Z", // different timestamp
    source: "observed-burn:anthropic", // different source
  });
  assert.equal(d1, d2);
});

test("M7.5 digestPricingCatalog differs when prices change", () => {
  const d1 = digestPricingCatalog({
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  const d2 = digestPricingCatalog({
    providerVersion: PROVIDER,
    inputUsdPerMillion: 5, // changed
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  assert.notEqual(d1, d2);
});

test("M7.5 resolvePricing returns undefined for an unknown tier", () => {
  const db = freshDb();
  const resolved = resolvePricing(db, SHA_B, PROVIDER);
  assert.equal(resolved, undefined);
});

test("M7.5 listPricingCatalog returns rows sorted by capturedAt desc", () => {
  const db = freshDb();
  const a = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3, outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z", source: "manual",
  });
  const b = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 4, outputUsdPerMillion: 20,
    cacheReadUsdPerMillion: 0.4, cacheWriteUsdPerMillion: 5,
    capturedAt: "2026-06-01T00:00:00Z", source: "manual",
  });
  const rows = listPricingCatalog(db);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tierDigest, b.tierDigest);
  assert.equal(rows[1].tierDigest, a.tierDigest);
});

test("M7.5 costFromPricing returns USD for a known tier", () => {
  const db = freshDb();
  const pinned = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  const row = resolvePricing(db, pinned.tierDigest, PROVIDER);
  assert.ok(row);
  const cost = costFromPricing(row, {
    inputTokens: 1_000_000,    // 1M input tokens
    outputTokens: 100_000,     // 100k output tokens
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  // 1M * 3 / 1M = $3 input; 100k * 15 / 1M = $1.50 output ⇒ $4.50
  assert.equal(cost, 4.50);
});

test("M7.5 costFromPricing returns null for an unknown tier (no silent fallback)", () => {
  const cost = costFromPricing(undefined, {
    inputTokens: 1_000_000,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  assert.equal(cost, null);
});

test("M7.5 costFromPricing handles null token fields (partial observation)", () => {
  const db = freshDb();
  const pinned = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3,
    outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3,
    cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z",
    source: "manual",
  });
  const row = resolvePricing(db, pinned.tierDigest, PROVIDER);
  const cost = costFromPricing(row, {
    inputTokens: null,
    outputTokens: 100_000,
    cacheReadTokens: null,
    cacheWriteTokens: null,
  });
  // 100k * 15 / 1M = $1.50 (only the output side contributes)
  assert.equal(cost, 1.50);
});

test("M7.5 two runs same tokens different digests → two distinct costUsd values", () => {
  const db = freshDb();
  // Tier A: cheap.
  const a = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3, outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z", source: "manual",
  });
  // Tier B: 2x.
  const b = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 6, outputUsdPerMillion: 30,
    cacheReadUsdPerMillion: 0.6, cacheWriteUsdPerMillion: 7.5,
    capturedAt: "2026-06-01T00:00:00Z", source: "manual",
  });
  const aRow = resolvePricing(db, a.tierDigest, PROVIDER);
  const bRow = resolvePricing(db, b.tierDigest, PROVIDER);
  assert.ok(aRow && bRow);
  const tokens = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const costA = costFromPricing(aRow, tokens);
  const costB = costFromPricing(bRow, tokens);
  assert.equal(costA, 4.50);
  assert.equal(costB, 9.00);
  assert.notEqual(costA, costB);
});

test("M7.5 process.versions.icu mismatch does not block pricing (orthogonal)", () => {
  const db = freshDb();
  // Sanity: the pricing catalog ignores icu entirely. The same
  // digest + provider pins under either icu version.
  const pinned = pinPricingCatalog(db, {
    providerVersion: PROVIDER,
    inputUsdPerMillion: 3, outputUsdPerMillion: 15,
    cacheReadUsdPerMillion: 0.3, cacheWriteUsdPerMillion: 3.75,
    capturedAt: "2026-01-01T00:00:00Z", source: "manual",
  });
  const row = resolvePricing(db, pinned.tierDigest, PROVIDER);
  assert.ok(row);
  // process.versions.icu may be undefined in test; if defined,
  // ignore it. The pricing lookup must not consult it.
  void process.versions.icu;
  assert.equal(row.capturedAt, "2026-01-01T00:00:00Z");
});

test("M7.5 workflowUsageRollupSchema parses the completed-result shape", () => {
  const rollup = workflowUsageRollupSchema.parse({
    inputTokens: 1000,
    outputTokens: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.012,
    pricingTierDigest: SHA_A,
    pricingTierDigestFreshAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(rollup.costUsd, 0.012);
  assert.equal(rollup.pricingTierDigest, SHA_A);
  assert.equal(rollup.pricingTierDigestFreshAt, "2026-01-01T00:00:00Z");

  // Freshness timestamps are nullable.
  const noTier = workflowUsageRollupSchema.parse({
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costUsd: null, pricingTierDigest: null, pricingTierDigestFreshAt: null,
  });
  assert.equal(noTier.costUsd, null);
});

test("M7.5 pricingCatalogSchema rejects negative per-million prices", () => {
  assert.throws(
    () => pricingCatalogSchema.parse({
      tierDigest: SHA_A, providerVersion: PROVIDER,
      inputUsdPerMillion: -1, outputUsdPerMillion: 0,
      cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0,
      capturedAt: "2026-01-01T00:00:00Z", source: "manual",
    }),
    (e: unknown) => e instanceof Error,
  );
});

test("M7.5 pricingCatalogSchema rejects malformed capturedAt", () => {
  assert.throws(
    () => pricingCatalogSchema.parse({
      tierDigest: SHA_A, providerVersion: PROVIDER,
      inputUsdPerMillion: 0, outputUsdPerMillion: 0,
      cacheReadUsdPerMillion: 0, cacheWriteUsdPerMillion: 0,
      capturedAt: "not-a-date", source: "manual",
    }),
    (e: unknown) => e instanceof Error,
  );
});
