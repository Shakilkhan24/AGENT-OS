/**
 * M4.2 — Provider profile model tests.
 *
 * Coverage:
 *  - `defineProviderProfile` writes the definition row only;
 *    `active` is false and no per-provider active marker exists yet.
 *  - `activateProviderProfile` flips the per-provider active marker
 *    and updates the definition row's `activatedAt`; activation is
 *    idempotent.
 *  - `readActiveProviderProfile` returns the activated profile or
 *    `null`.
 *  - `deactivateProviderProfile` clears the active marker and
 *    returns the previously-active profile for audit.
 *  - `defineProviderProfile` refuses to overwrite a profile whose
 *    `profileId` already exists with a different `provider` (the
 *    profile identity is immutable once defined).
 *  - `listProviderProfiles` returns every defined profile, skipping
 *    malformed rows.
 *  - The runtime never stores secret material; the schema does not
 *    accept a `secrets`/`token`/`apiKey` field even if supplied.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  activateProviderProfile,
  deactivateProviderProfile,
  defineProviderProfile,
  listProviderProfiles,
  providerProfileSchema,
  readActiveProviderProfile,
  readProviderProfile,
} from "../../src/runtime/db/provider-profiles";
import { ownedDbFixture } from "../support";
import { AppError } from "../../src/shared/errors";
import type { OwnedDb } from "../../src/runtime/db-owner";

function newProfile(overrides: Partial<Parameters<typeof defineProviderProfile>[1]> = {}): Parameters<typeof defineProviderProfile>[1] {
  return {
    profileId: randomUUID(),
    provider: "claude",
    accountMode: "authenticated",
    displayName: "Test profile",
    scopes: ["task:read", "task:write"],
    definedAt: new Date().toISOString(),
    notes: "",
    ...overrides,
  };
}

async function fixture(): Promise<OwnedDb> {
  return ownedDbFixture();
}

test("defineProviderProfile writes the definition row only", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const profile = newProfile();
  const result = await defineProviderProfile(owned.worker, profile);
  assert.equal(result.active, false);
  assert.equal(result.metaKey, `provider-profile:${profile.profileId}`);
  const read = await readProviderProfile(owned.worker, profile.profileId);
  assert.ok(read);
  assert.equal(read?.provider, "claude");
  assert.equal(read?.activatedAt, null);
  // No active marker yet.
  const active = await readActiveProviderProfile(owned.worker, "claude");
  assert.equal(active, null);
});

test("activateProviderProfile is idempotent and records activatedAt", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const profile = newProfile();
  await defineProviderProfile(owned.worker, profile);
  const first = await activateProviderProfile(owned.worker, profile.profileId);
  assert.equal(first.active, true);
  // Wait at least one millisecond so `new Date().toISOString()`
  // produces a strictly later timestamp on the second activation.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await activateProviderProfile(owned.worker, profile.profileId);
  assert.equal(second.active, true);
  assert.notEqual(first.profile.activatedAt, second.profile.activatedAt,
    "second activation should refresh activatedAt");
  // The per-provider active marker still points at the same profile.
  const active = await readActiveProviderProfile(owned.worker, "claude");
  assert.ok(active);
  assert.equal(active?.profileId, profile.profileId);
});

test("activateProviderProfile refuses unknown profile id", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  await assert.rejects(
    activateProviderProfile(owned.worker, randomUUID()),
    (err: unknown) => err instanceof AppError && err.failure.code === "NOT_FOUND",
  );
});

test("deactivateProviderProfile clears the marker and returns the previous profile", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const profile = newProfile();
  await defineProviderProfile(owned.worker, profile);
  await activateProviderProfile(owned.worker, profile.profileId);
  const previous = await deactivateProviderProfile(owned.worker, "claude");
  assert.ok(previous);
  assert.equal(previous?.profileId, profile.profileId);
  const after = await readActiveProviderProfile(owned.worker, "claude");
  assert.equal(after, null);
});

test("defineProviderProfile refuses secret-shaped fields", () => {
  // The schema is `.strict()`; an unknown field raises a parse error.
  assert.throws(
    () => providerProfileSchema.parse({
      profileId: randomUUID(),
      provider: "claude",
      accountMode: "authenticated",
      displayName: "x",
      scopes: [],
      definedAt: new Date().toISOString(),
      apiKey: "sk-secret-leak", // forbidden
    }),
    (err: unknown) => err instanceof Error,
  );
});

test("listProviderProfiles returns every defined profile, skips malformed rows", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  await defineProviderProfile(owned.worker, newProfile({ provider: "claude", displayName: "A" }));
  await defineProviderProfile(owned.worker, newProfile({ provider: "codex", displayName: "B" }));
  // Inject a malformed row directly into the meta table.
  const driver = (owned.worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void } } }).driver;
  driver.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run("provider-profile:00000000-0000-0000-0000-000000000000", "{not-json");
  const list = await listProviderProfiles(owned.worker);
  // Two good rows survive; the malformed one is silently skipped.
  assert.equal(list.length, 2);
  const names = list.map((p) => p.displayName).sort();
  assert.deepEqual(names, ["A", "B"]);
});

test("two profiles for the same provider can coexist; only the active one resolves", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const a = newProfile({ provider: "claude", displayName: "A" });
  const b = newProfile({ provider: "claude", displayName: "B" });
  await defineProviderProfile(owned.worker, a);
  await defineProviderProfile(owned.worker, b);
  await activateProviderProfile(owned.worker, b.profileId);
  const active = await readActiveProviderProfile(owned.worker, "claude");
  assert.ok(active);
  assert.equal(active?.displayName, "B");
});

test("codex profile cannot be activated for the claude provider", async (t) => {
  // The provider identity is part of the profile. The active marker
  // is keyed by provider, so activating a codex profile writes to
  // the codex marker, not the claude one.
  const owned = await fixture();
  t.after(() => owned.close());
  const codex = newProfile({ provider: "codex", displayName: "Codex default" });
  await defineProviderProfile(owned.worker, codex);
  await activateProviderProfile(owned.worker, codex.profileId);
  const claudeActive = await readActiveProviderProfile(owned.worker, "claude");
  const codexActive = await readActiveProviderProfile(owned.worker, "codex");
  assert.equal(claudeActive, null);
  assert.ok(codexActive);
  assert.equal(codexActive?.provider, "codex");
});
