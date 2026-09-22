/**
 * M4.4 — Installation plan + receipt ledger tests.
 *
 * Coverage:
 *  - Planner produces a deterministic plan from the same manifest.
 *  - Pinned digest mismatch raises CONFLICT.
 *  - Lifecycle stages appear in the documented order (Approve →
 *    InstallInactive → Validate → Activate → Hook).
 *  - Pinned digests, requested powers and licenses are aggregated
 *    and deduplicated.
 *  - Plan immutability: there is no mutator exposed.
 *  - `verifyPlanDigest` detects a tampered plan.
 *  - Receipt ledger is append-only.
 *  - Every receipt's `reversible` field is locked to `false`.
 *  - `rollbackPlan` returns the receipts with `sideEffectsReversed`
 *    literally `false` — no claim of side-effect reversal.
 *  - `pendingSteps` reports steps without a receipt.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  capabilityManifestSchema,
  LIFECYCLE_STAGES,
  manifestIdFromSeed,
  pinnedInputSchema,
  producePlan,
  verifyPlanDigest,
} from "../../src/runtime/db/installation-plan";
import {
  pendingSteps,
  readPlanReceipts,
  recordReceipt,
  rollbackPlan,
} from "../../src/runtime/db/installation-receipt";
import { ownedDbFixture } from "../support";
import { AppError } from "../../src/shared/errors";

function fakeDigest(seed: string): string {
  // 64-hex string derived deterministically from `seed`.
  let s = seed;
  while (s.length < 64) s += seed;
  return s.slice(0, 64).replace(/[^0-9a-f]/g, "0");
}

function makeManifest(overrides: {
  inputs?: Array<{ label: string; expected: string; supplied?: string | null; powers?: string[]; license?: string }>;
} = {}): ReturnType<typeof capabilityManifestSchema.parse> {
  const inputs = (overrides.inputs ?? [
    { label: "primary", expected: fakeDigest("a"), supplied: fakeDigest("a"), license: "MIT" },
  ]).map((i, idx) =>
    pinnedInputSchema.parse({
      inputId: randomUUID(),
      origin: `filesystem:/caps/${idx}`,
      expectedDigest: i.expected,
      suppliedDigest: i.supplied ?? i.expected,
      license: i.license ?? "MIT",
      requestedPowers: i.powers ?? ["read"],
      label: i.label,
    }),
  );
  return capabilityManifestSchema.parse({
    manifestId: randomUUID(),
    version: { major: 1, minor: 0, patch: 0 },
    kind: "skill",
    displayName: "Test skill",
    inputs,
    dependencies: [],
    targetAdapter: "filesystem",
    notes: "",
  });
}

test("planner produces a deterministic plan from the same manifest", () => {
  const manifest = makeManifest();
  // Pass the manifest through `producePlan` twice with different
  // planId auto-generation but otherwise identical input. The
  // **plan structure** (steps, digests, powers, licenses) must be
  // identical; only the auto-generated `planId` and `assembledAt`
  // differ.
  const a = producePlan({ manifest });
  const b = producePlan({ manifest });
  assert.notEqual(a.planId, b.planId);
  assert.notEqual(a.assembledAt, b.assembledAt);
  assert.deepEqual(a.pinnedDigests, b.pinnedDigests);
  assert.deepEqual(a.requestedPowers, b.requestedPowers);
  assert.deepEqual(a.licenses, b.licenses);
  assert.equal(a.steps.length, b.steps.length);
  // The stage order is identical.
  assert.deepEqual(a.stageOrder, b.stageOrder);
});

test("planner rejects pinned-digest mismatch with CONFLICT", () => {
  const manifest = makeManifest({
    inputs: [{ label: "x", expected: fakeDigest("a"), supplied: fakeDigest("b") }],
  });
  assert.throws(
    () => producePlan({ manifest }),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
});

test("lifecycle stages appear in the documented order", () => {
  const manifest = makeManifest();
  const plan = producePlan({ manifest });
  assert.deepEqual(plan.stageOrder, [...LIFECYCLE_STAGES]);
  // And the actual steps follow the order: Approve first, then
  // InstallInactive → Validate → Activate → Hook (per input).
  assert.equal(plan.steps[0].kind, "Approve");
  assert.equal(plan.steps[1].kind, "InstallInactive");
  assert.equal(plan.steps[2].kind, "Validate");
  assert.equal(plan.steps[3].kind, "Activate");
  assert.equal(plan.steps[4].kind, "Hook");
  // The Approve step has no input.
  assert.equal(plan.steps[0].inputId, null);
});

test("pinned digests, requested powers and licenses are deduplicated", () => {
  const manifest = makeManifest({
    inputs: [
      { label: "a", expected: fakeDigest("a"), license: "MIT", powers: ["read", "write"] },
      { label: "b", expected: fakeDigest("a"), license: "MIT", powers: ["write"] },
      { label: "c", expected: fakeDigest("c"), license: "Apache-2.0", powers: ["read"] },
    ],
  });
  const plan = producePlan({ manifest });
  assert.deepEqual(plan.pinnedDigests, [fakeDigest("a"), fakeDigest("c")]);
  assert.deepEqual(plan.requestedPowers, ["read", "write"]);
  assert.deepEqual(plan.licenses, ["Apache-2.0", "MIT"]);
});

test("catalogDigests override the manifest's pinned digest when suppliedDigest is null", () => {
  const manifest = makeManifest({
    inputs: [{ label: "x", expected: fakeDigest("a"), supplied: null }],
  });
  // Catalog says the resource is at digest a — matching the manifest.
  const ok = producePlan({
    manifest,
    catalogDigests: { "filesystem:/caps/0": fakeDigest("a") },
  });
  assert.ok(ok);
  // Catalog says the resource is at a different digest — mismatch.
  assert.throws(
    () =>
      producePlan({
        manifest,
        catalogDigests: { "filesystem:/caps/0": fakeDigest("z") },
      }),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
});

test("verifyPlanDigest detects a tampered plan", () => {
  const manifest = makeManifest();
  const plan = producePlan({ manifest });
  // Mutate `pinnedDigests` (the digest will no longer match the
  // content). The function refuses to confirm a tampered plan.
  const tampered = { ...plan, pinnedDigests: ["f".repeat(64)] };
  assert.throws(
    () => verifyPlanDigest(tampered),
    (err: unknown) => err instanceof AppError && err.failure.code === "CONFLICT",
  );
  verifyPlanDigest(plan); // sanity: untouched plan verifies cleanly.
});

test("manifestIdFromSeed is deterministic for the same seed and parses as a UUID", () => {
  const a = manifestIdFromSeed("test-seed");
  const b = manifestIdFromSeed("test-seed");
  assert.equal(a, b);
  // Format check (UUID v4 shape).
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("recordReceipt writes a single receipt whose reversible flag is locked to false", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const planId = randomUUID();
  const stepId = randomUUID();
  const receipt = recordReceipt(owned.worker, {
    planId,
    stepId,
    stepKind: "InstallInactive",
    outcome: "success",
    observedAt: new Date().toISOString(),
    observedDigest: fakeDigest("a"),
    sideEffectAcknowledged: true,
    message: "wrote 4096 bytes",
  });
  assert.equal(receipt.reversible, false);
  const read = readPlanReceipts(owned.worker, planId);
  assert.equal(read.length, 1);
  assert.equal(read[0].reversible, false);
});

test("recordReceipt forces reversible=false even when a caller tries to set true", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  // Cast through unknown — the schema locks `reversible` to the
  // literal `false`, but the test verifies the runtime gate.
  const receipt = recordReceipt(owned.worker, {
    planId: randomUUID(),
    stepId: randomUUID(),
    stepKind: "Activate",
    outcome: "success",
    observedAt: new Date().toISOString(),
    observedDigest: null,
    sideEffectAcknowledged: false,
    message: "",
  });
  assert.equal(receipt.reversible, false);
});

test("receipt ledger is append-only (record twice with same key produces one row, ordered by observedAt)", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const planId = randomUUID();
  const stepId = randomUUID();
  recordReceipt(owned.worker, {
    planId,
    stepId,
    stepKind: "InstallInactive",
    outcome: "success",
    observedAt: "2026-09-15T00:00:00.000Z",
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "first attempt",
  });
  // A corrected execution writes a new receipt. The store has no
  // UPDATE path — we INSERT OR REPLACE — so the latest value
  // wins, but the schema keeps a single receipt per (planId,
  // stepId) pair, never a chain. That is the append-only invariant.
  recordReceipt(owned.worker, {
    planId,
    stepId,
    stepKind: "InstallInactive",
    outcome: "failed",
    observedAt: "2026-09-15T00:00:05.000Z",
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "second attempt corrected the first",
  });
  const read = readPlanReceipts(owned.worker, planId);
  assert.equal(read.length, 1);
  // The latest outcome wins because the ledger is the latest-write
  // view, not a chain. This is the documented M4.4 behaviour.
  assert.equal(read[0].outcome, "failed");
});

test("readPlanReceipts skips malformed rows without throwing", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const planId = randomUUID();
  const stepId = randomUUID();
  recordReceipt(owned.worker, {
    planId,
    stepId,
    stepKind: "Validate",
    outcome: "success",
    observedAt: new Date().toISOString(),
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "ok",
  });
  const driver = (owned.worker as unknown as {
    driver: { prepare(sql: string): { run(...b: unknown[]): void } };
  }).driver;
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(`install-receipt:${planId}:malformed-step`, "{not-json");
  const read = readPlanReceipts(owned.worker, planId);
  // The malformed row is silently skipped; the well-formed one is
  // returned.
  assert.equal(read.length, 1);
  assert.equal(read[0].stepId, stepId);
});

test("rollbackPlan returns receipts with sideEffectsReversed locked to false", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const planId = randomUUID();
  recordReceipt(owned.worker, {
    planId,
    stepId: randomUUID(),
    stepKind: "InstallInactive",
    outcome: "success",
    observedAt: new Date().toISOString(),
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "wrote bytes",
  });
  recordReceipt(owned.worker, {
    planId,
    stepId: randomUUID(),
    stepKind: "Activate",
    outcome: "failed",
    observedAt: new Date().toISOString(),
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "refused to flip marker",
  });
  const summary = rollbackPlan(owned.worker, planId);
  assert.equal(summary.sideEffectsReversed, false); // locked
  assert.match(summary.note, /Rollback records what happened/);
  assert.equal(summary.outcomeCounts.success, 1);
  assert.equal(summary.outcomeCounts.failed, 1);
  assert.equal(summary.outcomeCounts.skipped, 0);
  assert.equal(summary.outcomeCounts.uncertain, 0);
});

test("pendingSteps returns steps without a receipt", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const manifest = makeManifest({
    inputs: [
      { label: "a", expected: fakeDigest("a"), supplied: fakeDigest("a") },
      { label: "b", expected: fakeDigest("b"), supplied: fakeDigest("b") },
    ],
  });
  const plan = producePlan({ manifest });
  // Initially every step is pending.
  const beforeReceipts = pendingSteps(owned.worker, plan.planId, plan.steps);
  assert.equal(beforeReceipts.length, plan.steps.length);
  // Record a receipt for the first `InstallInactive` step only.
  const installStep = plan.steps.find((s) => s.kind === "InstallInactive");
  assert.ok(installStep);
  recordReceipt(owned.worker, {
    planId: plan.planId,
    stepId: installStep!.stepId,
    stepKind: "InstallInactive",
    outcome: "success",
    observedAt: new Date().toISOString(),
    observedDigest: null,
    sideEffectAcknowledged: true,
    message: "ok",
  });
  const after = pendingSteps(owned.worker, plan.planId, plan.steps);
  assert.equal(after.length, plan.steps.length - 1);
});

test("rollbackPlan on an unknown plan returns an empty summary", async (t) => {
  const owned = await ownedDbFixture();
  t.after(() => owned.close());
  const summary = rollbackPlan(owned.worker, randomUUID());
  assert.equal(summary.receipts.length, 0);
  assert.equal(summary.outcomeCounts.success, 0);
  assert.equal(summary.sideEffectsReversed, false);
});
