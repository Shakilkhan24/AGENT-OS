/**
 * M5.6 — saved layout + v2→v3 migration tests.
 *
 * Coverage (9 focused tests):
 *  - migrateLayoutV2toV3 adds empty `layouts` + bumps version to 3
 *  - hydrateLayouts keeps well-formed entries + drops malformed ones
 *  - digestLayout is stable for identical inputs
 *  - savedLayoutSchema rejects unknown top-level fields
 *  - savedLayoutSchema rejects ratio outside [0.1, 0.9]
 *  - savedLayoutSchema rejects activeTerminalId that's not a UUID
 *  - savedLayoutSchema rejects hiddenTerminalIds > 64 entries
 *  - resolveTerminalLifecyclePolicy maps `graceful` → `stop-and-remove`
 *  - ensureLayoutVersion migrates v2 to v3 and throws on v4
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  countLayouts,
  digestLayout,
  emptySavedLayout,
  ensureLayoutVersion,
  hydrateLayouts,
  migrateLayoutV2toV3,
  serializeLayouts,
} from "../../src/runtime/orchestration/layout";
import {
  resolveTerminalLifecyclePolicy,
  savedLayoutSchema,
} from "../../src/shared/workspace6-schema";

test("migrateLayoutV2toV3 adds an empty layouts map + bumps version to 3", () => {
  const v2 = { version: 2, sessions: [], presets: [], envProfiles: [], hooks: [], launches: [] } as Record<string, unknown> & { version: 2 };
  const v3 = migrateLayoutV2toV3(v2);
  assert.equal(v3.version, 3);
  assert.deepEqual(v3.layouts, {});
});

test("hydrateLayouts keeps well-formed v3 entries and drops malformed ones", () => {
  const goodSession = randomUUID();
  const malformedSession = randomUUID();
  const good = { version: 3 as const, sessionId: goodSession, split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: null, hiddenTerminalIds: [] }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString() };
  const malformed = { version: 3 as const, sessionId: malformedSession, split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: null, hiddenTerminalIds: [] }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString(), bogus: "extra" };
  const { kept, dropped } = hydrateLayouts({ layouts: { [goodSession]: good, [malformedSession]: malformed } });
  assert.equal(kept.length, 1);
  assert.equal(kept[0][0], goodSession);
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0], malformedSession);
});

test("digestLayout is stable for identical inputs", () => {
  const sessionId = randomUUID();
  const a = digestLayout(sessionId, { enabled: true, ratio: 0.6 },
    { activeTerminalId: null, hiddenTerminalIds: [] },
    { activeTerminalId: null, hiddenTerminalIds: [] });
  const b = digestLayout(sessionId, { enabled: true, ratio: 0.6 },
    { activeTerminalId: null, hiddenTerminalIds: [] },
    { activeTerminalId: null, hiddenTerminalIds: [] });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("digestLayout differs when ratio changes", () => {
  const sessionId = randomUUID();
  const top = { activeTerminalId: null, hiddenTerminalIds: [] };
  const bottom = { activeTerminalId: null, hiddenTerminalIds: [] };
  const a = digestLayout(sessionId, { enabled: true, ratio: 0.4 }, top, bottom);
  const b = digestLayout(sessionId, { enabled: true, ratio: 0.6 }, top, bottom);
  assert.notEqual(a, b);
});

test("savedLayoutSchema rejects unknown top-level fields", () => {
  const sessionId = randomUUID();
  const base = { version: 3 as const, sessionId, split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: null, hiddenTerminalIds: [] }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString() };
  assert.throws(() => savedLayoutSchema.parse({ ...base, bogus: true }));
});

test("savedLayoutSchema rejects ratio outside [0.1, 0.9]", () => {
  const sessionId = randomUUID();
  const base = { version: 3 as const, sessionId, split: { enabled: false, ratio: 0.05 },
    top: { activeTerminalId: null, hiddenTerminalIds: [] }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString() };
  assert.throws(() => savedLayoutSchema.parse(base));
});

test("savedLayoutSchema rejects activeTerminalId that is not a UUID", () => {
  const sessionId = randomUUID();
  const base = { version: 3 as const, sessionId, split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: "not-a-uuid", hiddenTerminalIds: [] }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString() };
  assert.throws(() => savedLayoutSchema.parse(base));
});

test("savedLayoutSchema rejects hiddenTerminalIds > 64 entries", () => {
  const sessionId = randomUUID();
  const hidden = Array.from({ length: 65 }, () => randomUUID());
  const base = { version: 3 as const, sessionId, split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: null, hiddenTerminalIds: hidden }, bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64), updatedAt: new Date().toISOString() };
  assert.throws(() => savedLayoutSchema.parse(base));
});

test("resolveTerminalLifecyclePolicy maps `graceful` → `stop-and-remove` and leaves the explicit policies unchanged", () => {
  assert.equal(resolveTerminalLifecyclePolicy("graceful"), "stop-and-remove");
  assert.equal(resolveTerminalLifecyclePolicy("hide"), "hide");
  assert.equal(resolveTerminalLifecyclePolicy("stop-and-remove"), "stop-and-remove");
  assert.equal(resolveTerminalLifecyclePolicy("delete-history"), "delete-history");
});

test("ensureLayoutVersion migrates v2 → v3 and throws on v4", () => {
  const v2 = { version: 2 } as { version: 2 };
  const v3 = ensureLayoutVersion(v2);
  assert.equal(v3.version, 3);
  assert.throws(() => ensureLayoutVersion({ version: 4 }));
});

test("emptySavedLayout + serializeLayouts round-trip", () => {
  const sessionId = randomUUID();
  const empty = emptySavedLayout(sessionId, 0.5);
  assert.equal(empty.split.ratio, 0.5);
  assert.equal(empty.split.enabled, false);
  // digest is computed from {sessionId, split, top, bottom}.
  assert.equal(empty.layoutDigest, digestLayout(sessionId, empty.split, empty.top, empty.bottom));

  const map = new Map([[sessionId, { version: 3 as const, sessionId, split: empty.split,
    top: empty.top, bottom: empty.bottom, layoutDigest: empty.layoutDigest, updatedAt: new Date().toISOString() }]]);
  const serialized = serializeLayouts(map);
  assert.equal(Object.keys(serialized).length, 1);
  assert.equal(serialized[sessionId].sessionId, sessionId);
});

test("countLayouts reads the layouts map on a v3 state", () => {
  const v3 = { version: 3 as const, sessions: [], presets: [], envProfiles: [], hooks: [], launches: [],
    layouts: {} };
  assert.equal(countLayouts(v3 as never), 0);
});
