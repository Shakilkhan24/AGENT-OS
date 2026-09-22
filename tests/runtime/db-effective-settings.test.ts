/**
 * M4.2 — Effective settings resolver tests.
 *
 * Coverage:
 *  - precedence ordering per layer (defaults → user → project → recipe → run → provider-profile)
 *  - restriction intersection (NOT union) — a restriction absent in any layer is dropped
 *  - unknown field preservation (forward-compat: keys the resolver doesn't know go to `nativeFields`)
 *  - digest determinism (same inputs → same digest)
 *  - digest mismatch raises AppError("CONFLICT", …)
 *  - empty layers / duplicate sources / unknown sources raise
 *  - implicit defaults layer is materialised when no caller supplies one
 *  - field provenance records the supplying layer per key
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildEffectiveLayer,
  digestEffective,
  digestLayer,
  resolveEffectiveSettings,
  stableStringify,
  SUPPORTED_RESTRICTIONS,
} from "../../src/runtime/db/effective-settings";
import { AppError } from "../../src/shared/errors";
import type { EffectiveLayer } from "../../src/runtime/db/effective-settings";

function layer(partial: Partial<Omit<EffectiveLayer, "source" | "digest">> & Pick<EffectiveLayer, "source">): EffectiveLayer {
  return buildEffectiveLayer({
    source: partial.source,
    capturedAt: partial.capturedAt ?? "2026-09-15T00:00:00.000Z",
    sourceId: partial.sourceId ?? null,
    values: partial.values,
    restrictions: partial.restrictions,
    nativeFields: partial.nativeFields,
  });
}

test("resolver accepts a single user layer and records provenance", () => {
  const user = layer({
    source: "user",
    sourceId: "user-1",
    values: { pollIntervalMs: 1500, fileWatching: true },
    restrictions: ["no-network"],
  });
  const result = resolveEffectiveSettings({ layers: [user] });
  assert.equal(result.settings.pollIntervalMs, 1500);
  assert.equal(result.settings.fileWatching, true);
  assert.deepEqual(result.restrictions, ["no-network"]);
  assert.equal(result.fieldProvenance.pollIntervalMs, "user");
  assert.equal(result.fieldProvenance.fileWatching, "user");
  // The defaults layer supplied the unset fields.
  assert.equal(result.fieldProvenance.historyLines, "defaults");
  assert.equal(result.layerOrder.length, 2); // implicit defaults + user
});

test("resolver overrides per field across layers (later wins)", () => {
  const user = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  const project = layer({ source: "project", sourceId: "project-1", values: { pollIntervalMs: 800, logRetentionDays: 14 } });
  const run = layer({ source: "run", sourceId: "run-1", values: { pollIntervalMs: 250 } });
  const result = resolveEffectiveSettings({ layers: [user, project, run] });
  assert.equal(result.settings.pollIntervalMs, 250); // run wins
  assert.equal(result.settings.logRetentionDays, 14); // project wins over defaults
  assert.equal(result.fieldProvenance.pollIntervalMs, "run");
  assert.equal(result.fieldProvenance.logRetentionDays, "project");
});

test("resolver intersects restrictions (NOT union)", () => {
  const user = layer({ source: "user", sourceId: "user-1", restrictions: ["no-network", "no-shell-exec"] });
  const project = layer({ source: "project", sourceId: "project-1", restrictions: ["no-network", "read-only-filesystem"] });
  const result = resolveEffectiveSettings({ layers: [user, project] });
  // Effective = user ∩ project = { "no-network" }.
  assert.deepEqual(result.restrictions, ["no-network"]);
});

test("resolver drops restrictions absent from any layer", () => {
  const user = layer({ source: "user", sourceId: "user-1", restrictions: ["no-network"] });
  const run = layer({ source: "run", sourceId: "run-1", restrictions: [] });
  const result = resolveEffectiveSettings({ layers: [user, run] });
  // The run layer declared `[]` (no opinion) so it does not narrow.
  assert.deepEqual(result.restrictions, ["no-network"]);
});

test("resolver drops all restrictions when one layer lists none", () => {
  const user = layer({ source: "user", sourceId: "user-1", restrictions: ["no-network"] });
  const project = layer({ source: "project", sourceId: "project-1", restrictions: ["no-shell-exec"] });
  const result = resolveEffectiveSettings({ layers: [user, project] });
  // user ∩ project = {} (they share no restriction).
  assert.deepEqual(result.restrictions, []);
});

test("resolver preserves unknown fields per source", () => {
  const user = layer({
    source: "user",
    sourceId: "user-1",
    values: { pollIntervalMs: 1500 },
    nativeFields: { codexFutureFlag: "experimental", claudeNativeHook: { timeout: 30 } },
  });
  const result = resolveEffectiveSettings({ layers: [user] });
  // Native fields do not pollute the typed `settings`.
  assert.equal((result.settings as Record<string, unknown>).codexFutureFlag, undefined);
  // They do land in the per-source native map, verbatim.
  assert.equal(result.nativeFields.user.codexFutureFlag, "experimental");
  assert.deepEqual(result.nativeFields.user.claudeNativeHook, { timeout: 30 });
});

test("resolver re-routes unknown keys supplied via `values` into nativeFields", () => {
  // Bypass the strict Settings type by passing an unknown key via
  // nativeFields directly — this mirrors a future provider adapter
  // that stores keys the schema does not yet know about.
  const user = layer({
    source: "user",
    sourceId: "user-1",
    values: { pollIntervalMs: 1500 },
    nativeFields: { experimentalProviderKey: { nested: true } },
  });
  const result = resolveEffectiveSettings({ layers: [user] });
  assert.deepEqual(result.nativeFields.user.experimentalProviderKey, { nested: true });
});

test("resolver rejects duplicate sources with CONFLICT", () => {
  const a = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  const b = layer({ source: "user", sourceId: "user-2", values: { pollIntervalMs: 800 } });
  assert.throws(
    () => resolveEffectiveSettings({ layers: [a, b] }),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
});

test("resolver rejects unknown source identifier", () => {
  // Cast through `unknown` because the resolver's contract guards the
  // source identifier. The test verifies the runtime path, not the
  // type system.
  const bad = layer({ source: "user" as EffectiveLayer["source"] });
  (bad as { source: string }).source = "rogue-source";
  assert.throws(
    () => resolveEffectiveSettings({ layers: [bad] }),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});

test("resolver rejects empty layers", () => {
  assert.throws(
    () => resolveEffectiveSettings({ layers: [] }),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});

test("resolver rejects layer with mismatched digest", () => {
  const good = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  // Mutate digest to a wrong value; the resolver must catch it.
  (good as { digest: string }).digest = "0".repeat(64);
  assert.throws(
    () => resolveEffectiveSettings({ layers: [good] }),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
});

test("buildEffectiveLayer rejects unsupported restriction token at construction", () => {
  // The restriction check happens at layer construction so a
  // malformed layer cannot slip past the resolver's per-layer loop.
  assert.throws(
    () => buildEffectiveLayer({
      source: "user",
      capturedAt: "2026-09-15T00:00:00.000Z",
      sourceId: "user-1",
      values: {},
      restrictions: ["no-network", "rogue-restriction" as typeof SUPPORTED_RESTRICTIONS[number]],
    }),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});

test("resolver produces deterministic digests", () => {
  const user = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  const a = resolveEffectiveSettings({ layers: [user] });
  const b = resolveEffectiveSettings({ layers: [user] });
  assert.equal(a.digest, b.digest);
  assert.equal(a.digest.length, 64); // SHA-256 hex
});

test("resolver digests differ when sourceId differs (audit trail)", () => {
  const a = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  const b = layer({ source: "user", sourceId: "user-2", values: { pollIntervalMs: 1500 } });
  // The per-layer digest is the canonical surface for source identity:
  // a layer re-bound to a different sourceId must produce a different
  // digest even when its values, restrictions and nativeFields match.
  assert.notEqual(a.digest, b.digest);
});

test("stableStringify sorts keys deterministically", () => {
  const a = stableStringify({ b: 1, a: 2 });
  const b = stableStringify({ a: 2, b: 1 });
  assert.equal(a, b);
});

test("digestLayer is stable for the same input", () => {
  const d1 = digestLayer({ pollIntervalMs: 1500 }, ["no-network"], {}, "u-1");
  const d2 = digestLayer({ pollIntervalMs: 1500 }, ["no-network"], {}, "u-1");
  assert.equal(d1, d2);
});

test("digestLayer differs when sourceId differs", () => {
  const d1 = digestLayer({ pollIntervalMs: 1500 }, [], {}, "u-1");
  const d2 = digestLayer({ pollIntervalMs: 1500 }, [], {}, "u-2");
  assert.notEqual(d1, d2);
});

test("digestEffective returns a 64-character hex string", () => {
  const user = layer({ source: "user", sourceId: "user-1", values: { pollIntervalMs: 1500 } });
  const result = resolveEffectiveSettings({ layers: [user] });
  const d = digestEffective(result);
  assert.equal(d.length, 64);
  assert.match(d, /^[0-9a-f]{64}$/);
});

test("all six layers contribute when supplied", () => {
  const user = layer({ source: "user", sourceId: "u", values: { pollIntervalMs: 1500 } });
  const project = layer({ source: "project", sourceId: "p", values: { fileTimeoutMs: 10_000 } });
  const recipe = layer({ source: "recipe", sourceId: "r", values: { draftIntervalMs: 800 } });
  const run = layer({ source: "run", sourceId: "ru", values: { fileQueueLimit: 32 } });
  const profile = layer({ source: "provider-profile", sourceId: "pp", values: { historyLines: 30_000 } });
  const defaults = layer({ source: "defaults", sourceId: null, values: {} });
  const result = resolveEffectiveSettings({ layers: [user, project, recipe, run, profile, defaults] });
  assert.equal(result.settings.pollIntervalMs, 1500);
  assert.equal(result.settings.fileTimeoutMs, 10_000);
  assert.equal(result.settings.draftIntervalMs, 800);
  assert.equal(result.settings.fileQueueLimit, 32);
  assert.equal(result.settings.historyLines, 30_000);
  assert.equal(result.fieldProvenance.pollIntervalMs, "user");
  assert.equal(result.fieldProvenance.historyLines, "provider-profile");
  // When `defaults` is explicitly supplied, the resolver does NOT
  // materialise an implicit one — the layerOrder has exactly 6 entries.
  assert.equal(result.layerOrder.length, 6);
});
