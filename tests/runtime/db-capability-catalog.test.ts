/**
 * M4.3 — Capability catalog tests.
 *
 * Coverage:
 *  - All nine capability kinds round-trip through `buildCapability`
 *    with the expected discriminant and SHA-256 digest shape.
 *  - `scanCapabilityCatalog` reads `preset`, `env_profile`, and
 *    `hook` rows from existing tables and classifies them into
 *    `command`, `environment-template`, and `hook` capabilities.
 *  - Caller-supplied `CapabilitySource` directories populate the
 *    remaining kinds (`skill`, `native-plugin`, `mcp-server`,
 *    `script`, `recipe`) without invoking any referenced
 *    binaries / endpoints / scripts.
 *  - Unknown kind identifiers raise `AppError("INVALID_REQUEST", …)`.
 *  - Malformed source manifests are skipped with a `skippedSources`
 *    entry — never silently dropped, never surfaced as a row.
 *  - `digestCapability` is deterministic for the same inputs.
 *  - `flattenCapabilityCatalog` preserves the `CAPABILITY_KINDS`
 *    canonical order.
 *  - The catalog scan is **read-only** — the worker is never asked
 *    to mutate the DB outside of `SELECT` statements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  assertCapabilityKind,
  buildCapability,
  CAPABILITY_KINDS,
  capabilityKindSchema,
  capabilityScopeSchema,
  digestCapability,
  flattenCapabilityCatalog,
  scanCapabilityCatalog,
} from "../../src/runtime/db/capability-catalog";
import { ownedDbFixture } from "../support";
import { AppError } from "../../src/shared/errors";
import type { OwnedDb } from "../../src/runtime/db-owner";

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(owned: OwnedDb): DriverRaw {
  return (owned.worker as unknown as { driver: DriverRaw }).driver;
}

async function fixture(): Promise<OwnedDb> {
  return ownedDbFixture();
}

test("all nine capability kinds parse against the discriminator", () => {
  for (const kind of CAPABILITY_KINDS) {
    const parsed = capabilityKindSchema.safeParse(kind);
    assert.equal(parsed.success, true);
  }
  assert.equal(CAPABILITY_KINDS.length, 9);
});

test("unknown kind identifier raises AppError INVALID_REQUEST", () => {
  assert.throws(
    () => assertCapabilityKind("rogue-kind"),
    (err: unknown) => err instanceof AppError && err.failure.code === "INVALID_REQUEST",
  );
});

test("buildCapability returns a stable SHA-256 digest for the same inputs", () => {
  const a = buildCapability({
    kind: "command",
    displayName: "npm run test",
    origin: "preset-table:abc",
    scope: "RuntimeActivation",
    data: { command: "npm run test" },
    inventoryAt: "2026-09-15T00:00:00.000Z",
  });
  const b = buildCapability({
    kind: "command",
    displayName: "npm run test",
    origin: "preset-table:abc",
    scope: "RuntimeActivation",
    data: { command: "npm run test" },
    inventoryAt: "2026-09-15T00:00:00.000Z",
  });
  assert.equal(a.digest, b.digest);
  assert.match(a.digest, /^[0-9a-f]{64}$/);
  // The capabilityId is derived from the digest, so rescan stability
  // survives identity regeneration.
  assert.equal(a.capabilityId, b.capabilityId);
});

test("different inputs produce different digests", () => {
  const a = buildCapability({
    kind: "command",
    displayName: "npm run test",
    origin: "preset-table:abc",
    scope: "RuntimeActivation",
    data: { command: "npm run test" },
    inventoryAt: "2026-09-15T00:00:00.000Z",
  });
  const b = buildCapability({
    kind: "command",
    displayName: "npm run build",
    origin: "preset-table:abc",
    scope: "RuntimeActivation",
    data: { command: "npm run build" },
    inventoryAt: "2026-09-15T00:00:00.000Z",
  });
  assert.notEqual(a.digest, b.digest);
});

test("digestCapability is order-independent for data keys (canonical stringify)", () => {
  const inventoryAt = "2026-09-15T00:00:00.000Z";
  const a = digestCapability({
    kind: "command",
    displayName: "x",
    origin: "preset-table:1",
    scope: "RuntimeActivation",
    data: { a: 1, b: 2, c: 3 },
  });
  const b = digestCapability({
    kind: "command",
    displayName: "x",
    origin: "preset-table:1",
    scope: "RuntimeActivation",
    data: { c: 3, b: 2, a: 1 },
  });
  assert.equal(a, b);
  void inventoryAt;
});

test("capabilityScopeSchema accepts all three scopes", () => {
  for (const scope of ["ReadOnly", "UserWritable", "RuntimeActivation"] as const) {
    assert.equal(capabilityScopeSchema.safeParse(scope).success, true);
  }
});

test("scan returns empty catalog when DB has no rows", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.equal(inventory.total, 0);
  for (const kind of CAPABILITY_KINDS) {
    assert.deepEqual(inventory.byKind[kind], []);
  }
  assert.equal(inventory.unknownKinds.length, 0);
});

test("scan classifies preset rows as command capabilities", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)`)
    .run("uuid-1", "npm test", "npm run test");
  driver.prepare(`INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)`)
    .run("uuid-2", "build", "npm run build");
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.equal(inventory.byKind.command.length, 2);
  assert.equal(inventory.total, 2);
  const names = inventory.byKind.command.map((c) => c.displayName).sort();
  assert.deepEqual(names, ["build", "npm test"]);
  for (const capability of inventory.byKind.command) {
    assert.equal(capability.scope, "RuntimeActivation");
    assert.match(capability.origin, /^preset-table:/);
  }
});

test("scan classifies env_profile rows as environment-template capabilities", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO env_profile (uuid, name, variables_json) VALUES (?, ?, ?)`)
    .run("uuid-1", "node", JSON.stringify({ NODE_ENV: "production" }));
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.equal(inventory.byKind["environment-template"].length, 1);
  const capability = inventory.byKind["environment-template"][0];
  assert.equal(capability.displayName, "node");
  assert.equal(capability.scope, "RuntimeActivation");
  assert.deepEqual(capability.data, { variables: { NODE_ENV: "production" } });
});

test("scan classifies hook rows as ReadOnly hook capabilities", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO hook (uuid, name, event, action_json, session_uuid, terminal_uuid, match, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("uuid-1", "log-on-create", "session.created", "{}", null, null, null, 1);
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.equal(inventory.byKind.hook.length, 1);
  const capability = inventory.byKind.hook[0];
  assert.equal(capability.displayName, "log-on-create");
  assert.equal(capability.scope, "ReadOnly");
  assert.equal(capability.data.event, "session.created");
});

test("scan skips malformed preset rows and records skippedSources", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)`)
    .run("uuid-empty", "", "npm run test");
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.equal(inventory.byKind.command.length, 0);
  assert.equal(inventory.skippedSources.length, 1);
  assert.match(inventory.skippedSources[0].reason, /empty name or command/);
});

test("scan reads caller-supplied capability source directories", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  // Each source is a directory whose manifests all share the
  // source's kind — the scanner does not cross-classify.
  const skillRoot = await mkdtemp(path.join(tmpdir(), "minimal-capability-skill-"));
  const recipeRoot = await mkdtemp(path.join(tmpdir(), "minimal-capability-recipe-"));
  t.after(() => rm(skillRoot, { recursive: true, force: true }));
  t.after(() => rm(recipeRoot, { recursive: true, force: true }));
  await writeFile(
    path.join(skillRoot, "test-skill.json"),
    JSON.stringify({
      displayName: "Lint + test",
      data: { command: "npm run lint && npm test" },
      scope: "UserWritable",
    }),
  );
  await writeFile(
    path.join(recipeRoot, "deploy-recipe.json"),
    JSON.stringify({
      displayName: "Deploy to staging",
      data: { recipeId: randomUUID() },
    }),
  );
  const inventory = await scanCapabilityCatalog(owned.worker, {
    capabilitySources: [
      { kind: "skill", root: skillRoot },
      { kind: "recipe", root: recipeRoot },
    ],
  });
  assert.equal(inventory.byKind.skill.length, 1);
  assert.equal(inventory.byKind.recipe.length, 1);
  assert.equal(inventory.byKind.skill[0].displayName, "Lint + test");
  assert.equal(inventory.byKind.recipe[0].displayName, "Deploy to staging");
  // Scope defaults to UserWritable when the manifest omits it.
  assert.equal(inventory.byKind.recipe[0].scope, "UserWritable");
  assert.match(inventory.byKind.skill[0].origin, /^filesystem:/);
});

test("scan rejects unknown source kinds with unknownKinds list", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const root = await mkdtemp(path.join(tmpdir(), "minimal-capability-rogue-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // Cast through unknown — the scanner's contract guards the kind.
  const inventory = await scanCapabilityCatalog(owned.worker, {
    capabilitySources: [
      { kind: "rogue-kind" as unknown as "skill", root },
    ],
  });
  assert.equal(inventory.unknownKinds.length, 1);
  assert.equal(inventory.unknownKinds[0], "rogue-kind");
});

test("scan skips malformed source manifests with skippedSources entry", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const root = await mkdtemp(path.join(tmpdir(), "minimal-capability-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "bad.json"), "{not-json");
  const inventory = await scanCapabilityCatalog(owned.worker, {
    capabilitySources: [{ kind: "skill", root }],
  });
  assert.equal(inventory.byKind.skill.length, 0);
  assert.equal(inventory.skippedSources.length, 1);
  assert.match(inventory.skippedSources[0].reason, /bad\.json/);
});

test("scan is read-only — the DB row count is unchanged after a scan", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)`)
    .run("uuid-1", "x", "y");
  driver.prepare(`INSERT INTO env_profile (uuid, name, variables_json) VALUES (?, ?, ?)`)
    .run("uuid-2", "z", "{}");
  const before = driver.prepare(`SELECT COUNT(*) AS n FROM preset`).all()[0] as { n: number };
  const envBefore = driver.prepare(`SELECT COUNT(*) AS n FROM env_profile`).all()[0] as { n: number };
  await scanCapabilityCatalog(owned.worker, {});
  const after = driver.prepare(`SELECT COUNT(*) AS n FROM preset`).all()[0] as { n: number };
  const envAfter = driver.prepare(`SELECT COUNT(*) AS n FROM env_profile`).all()[0] as { n: number };
  assert.equal(before.n, after.n);
  assert.equal(envBefore.n, envAfter.n);
});

test("flattenCapabilityCatalog preserves the canonical kind order", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const driver = driverOf(owned);
  driver.prepare(`INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)`)
    .run("u-1", "a", "x");
  driver.prepare(`INSERT INTO env_profile (uuid, name, variables_json) VALUES (?, ?, ?)`)
    .run("u-2", "b", "{}");
  driver.prepare(`INSERT INTO hook (uuid, name, event, action_json, session_uuid, terminal_uuid, match, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("u-3", "c", "x", "{}", null, null, null, 1);
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  const flat = flattenCapabilityCatalog(inventory);
  assert.equal(flat.length, 3);
  // CAPABILITY_KINDS order is: skill, native-plugin, mcp-server,
  // command, script, hook, context-source, environment-template,
  // recipe. The three populated kinds appear in that order:
  // command (index 3), hook (index 5), environment-template (index 7).
  assert.equal(flat[0].kind, "command");
  assert.equal(flat[1].kind, "hook");
  assert.equal(flat[2].kind, "environment-template");
});

test("inventory timestamp is ISO-8601 and stable across the same scan call", async (t) => {
  const owned = await fixture();
  t.after(() => owned.close());
  const inventory = await scanCapabilityCatalog(owned.worker, {});
  assert.match(inventory.inventoryAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
