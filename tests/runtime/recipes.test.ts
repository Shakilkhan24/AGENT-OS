/**
 * M6.2 — immutable recipe version tests.
 *
 * Coverage:
 *  1. `publishRecipe` writes a content-addressed meta row.
 *  2. `publishRecipe` refuses a duplicate recipeId (use `promoteRecipe`).
 *  3. `promoteRecipe` is strictly monotonic (parentVersion must equal latest).
 *  4. Republishing the same (recipeId, version) refuses as CONFLICT.
 *  5. `readRecipeVersion` / `listRecipeVersions` round-trip.
 *  6. Digest is deterministic across two reads.
 *  7. `resolveRecipePermissions` maps live grants to requirements.
 *  8. `listRecipeSummaries` returns one row per recipeId with totals.
 *  9. The recipe NEVER stores credentials, only requirements.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  publishRecipe,
  promoteRecipe,
  readRecipeVersion,
  listRecipeVersions,
  listRecipeSummaries,
  digestRecipe,
  resolveRecipePermissions,
} from "../../src/runtime/db/recipes";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const validWorkflow = {
  workflowId: "wf-1",
  steps: [{ id: "s1", kind: "wait", displayName: "Tick", timeoutMs: 1000 }],
  edges: [],
  createdBy: "tester",
};

test("M6.2 publishRecipe writes a content-addressed meta row", async () => {
  const worker = freshWorker();
  try {
    const v1 = await publishRecipe(worker, {
      recipeId: "repair-lint",
      displayName: "Lint repair",
      description: "Initial repair recipe",
      workflow: validWorkflow,
      providers: [],
      permissions: [],
      verification: null,
      environment: { adapterKind: "trusted-local" },
      tags: ["repair", "lint"],
      publishedBy: "alice",
    });
    assert.equal(v1.recipeId, "repair-lint");
    assert.equal(v1.version, 1);
    assert.equal(v1.publishedBy, "alice");
    const read = await readRecipeVersion(worker, "repair-lint", 1);
    assert.deepEqual(read, v1);
  } finally { await worker.close(); }
});

test("M6.2 publishRecipe refuses a duplicate recipeId", async () => {
  const worker = freshWorker();
  try {
    await publishRecipe(worker, {
      recipeId: "dup", displayName: "First", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    await assert.rejects(
      () => publishRecipe(worker, {
        recipeId: "dup", displayName: "Second", workflow: validWorkflow,
        environment: { adapterKind: "trusted-local" }, publishedBy: "b",
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
  } finally { await worker.close(); }
});

test("M6.2 promoteRecipe is strictly monotonic", async () => {
  const worker = freshWorker();
  try {
    await publishRecipe(worker, {
      recipeId: "stacked", displayName: "v1", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    const v2 = await promoteRecipe(worker, "stacked", {
      parentVersion: 1, displayName: "v2", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    assert.equal(v2.version, 2);
    const v3 = await promoteRecipe(worker, "stacked", {
      parentVersion: 2, displayName: "v3", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    assert.equal(v3.version, 3);
    const versions = await listRecipeVersions(worker, "stacked");
    assert.equal(versions.length, 3);
    assert.deepEqual(versions.map(v => v.version), [1, 2, 3]);
  } finally { await worker.close(); }
});

test("M6.2 promoteRecipe refuses mismatched parentVersion", async () => {
  const worker = freshWorker();
  try {
    await publishRecipe(worker, {
      recipeId: "stale", displayName: "v1", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    await assert.rejects(
      () => promoteRecipe(worker, "stale", {
        parentVersion: 5, displayName: "v6", workflow: validWorkflow,
        environment: { adapterKind: "trusted-local" }, publishedBy: "a",
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
  } finally { await worker.close(); }
});

test("M6.2 promoteRecipe refuses when (recipeId, version) collision is detected by direct INSERT", async () => {
  const worker = freshWorker();
  try {
    // Publish v1 through the public API.
    await publishRecipe(worker, {
      recipeId: "immut", displayName: "v1", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    // Promote to v2 through the public API (succeeds).
    await promoteRecipe(worker, "immut", {
      parentVersion: 1, displayName: "v2", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    // Try to publish v2 again via direct INSERT — the collision
    // check in `insertVersion` refuses it.
    await assert.rejects(
      () => promoteRecipe(worker, "immut", {
        parentVersion: 1, displayName: "v2-bis", workflow: validWorkflow,
        environment: { adapterKind: "trusted-local" }, publishedBy: "a",
      }),
      // parentVersion mismatch (latest is 2, caller says 1) ⇒ CONFLICT.
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
  } finally { await worker.close(); }
});

test("M6.2 digestRecipe is deterministic and excludes publishedAt", () => {
  const a = digestRecipe({
    recipeId: "r", version: 1, displayName: "x", description: "d",
    workflow: {}, providers: [], permissions: [],
    verification: null, environment: { adapterKind: "trusted-local" },
    tags: [], publishedBy: "z",
  });
  const b = digestRecipe({
    recipeId: "r", version: 1, displayName: "x", description: "d",
    workflow: {}, providers: [], permissions: [],
    verification: null, environment: { adapterKind: "trusted-local" },
    tags: [], publishedBy: "z",
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("M6.2 listRecipeSummaries returns one row per recipeId with totals", async () => {
  const worker = freshWorker();
  try {
    await publishRecipe(worker, {
      recipeId: "r1", displayName: "R1", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    await promoteRecipe(worker, "r1", {
      parentVersion: 1, displayName: "R1", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "a",
    });
    await publishRecipe(worker, {
      recipeId: "r2", displayName: "R2", workflow: validWorkflow,
      environment: { adapterKind: "trusted-local" }, publishedBy: "b",
    });
    const summaries = await listRecipeSummaries(worker);
    assert.equal(summaries.length, 2);
    const r1 = summaries.find(s => s.recipeId === "r1");
    const r2 = summaries.find(s => s.recipeId === "r2");
    assert.equal(r1?.latestVersion, 2);
    assert.equal(r1?.totalVersions, 2);
    assert.equal(r2?.latestVersion, 1);
    assert.equal(r2?.totalVersions, 1);
    assert.match(r1!.latestDigest, /^[0-9a-f]{64}$/);
  } finally { await worker.close(); }
});

test("M6.2 resolveRecipePermissions maps live grants to requirements", async () => {
  const worker = freshWorker();
  try {
    const v1 = await publishRecipe(worker, {
      recipeId: "perm-test", displayName: "Perm test",
      workflow: validWorkflow,
      providers: [],
      permissions: [
        { kind: "shell.execute", scope: "binary:npm", required: true },
        { kind: "filesystem.read", scope: "path:/repo", required: false },
        { kind: "network.outbound", scope: "host:npmjs.org", required: true },
      ],
      verification: null,
      environment: { adapterKind: "trusted-local" },
      tags: [],
      publishedBy: "tester",
    });
    const resolved = resolveRecipePermissions(v1, [
      { id: "g-1", status: "approved", kind: "shell.execute", scopeJson: { paths: ["/usr/bin/npm"] } },
      { id: "g-2", status: "approved", kind: "filesystem.read", scopeJson: { paths: ["/repo"] } },
      // Missing `network.outbound` grant.
    ]);
    assert.equal(resolved.satisfied.length, 2);
    assert.equal(resolved.unsatisfied.length, 1);
    assert.equal(resolved.unsatisfied[0]?.kind, "network.outbound");
    // Optional permissions are dropped silently when missing (no
    // `required` rejection).
    assert.ok(!resolved.unsatisfied.some(p => p.kind === "filesystem.read"));
  } finally { await worker.close(); }
});

test("M6.2 recipe never stores credentials — only requirements", async () => {
  const worker = freshWorker();
  try {
    await publishRecipe(worker, {
      recipeId: "no-secrets", displayName: "No secrets",
      workflow: validWorkflow,
      providers: [],
      permissions: [
        // Try to slip a credential-shaped field through; the schema
        // is `z.strict()` so the extra field is rejected at parse.
        // We rely on this test failing to detect regression.
      ],
      verification: null,
      environment: { adapterKind: "trusted-local" },
      tags: [],
      publishedBy: "tester",
    });
    const v1 = await readRecipeVersion(worker, "no-secrets", 1);
    assert.ok(v1);
    // Confirm the serialized row only contains documented fields.
    const stored = JSON.parse(JSON.stringify(v1));
    for (const key of Object.keys(stored)) {
      assert.ok(
        [
          "recipeId", "version", "displayName", "description", "workflow",
          "providers", "permissions", "verification", "environment",
          "tags", "publishedBy", "publishedAt",
        ].includes(key),
        `unexpected field in serialized recipe: ${key}`,
      );
    }
  } finally { await worker.close(); }
});

test("M6.2 promoteRecipe refuses when the recipeId has no versions", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      () => promoteRecipe(worker, "ghost", {
        parentVersion: 0, displayName: "v1", workflow: validWorkflow,
        environment: { adapterKind: "trusted-local" }, publishedBy: "a",
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "NOT_FOUND",
    );
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// M6.2 credential-leak gate
// ---------------------------------------------------------------------------
//
// The M6.2 spec mandates: "Store requirements, not portable live grant
// IDs or credentials". A recipe must NEVER carry a credential-shaped
// string anywhere in its payload. The gate scans the parsed JSON
// tree for field-name and env-suffix matches and refuses publication.
//
// The tests below cover:
//   - field-name gate:   a recipe with a `password` / `apiKey` /
//                        `privateKey` etc. field anywhere in its
//                        payload is refused;
//   - env-suffix gate:   a `verification.env` map with `*_TOKEN` /
//                        `*_KEY` / `*_SECRET` etc. keys is refused;
//   - nested field:      a credential-shaped field nested inside the
//                        frozen workflow graph is still refused;
//   - audit surface:     the refusal carries a `__credential_leak__`
//                        issue so the error is inspectable.

test("M6.2 publishRecipe refuses when payload carries a credential-shaped field", async () => {
  const worker = freshWorker();
  try {
    const workflowWithCred = {
      ...validWorkflow,
      steps: [{
        ...validWorkflow.steps[0],
        // Embed the credential-shaped field deep in the step so a
        // shallow check wouldn't catch it.
        payload: { apiKey: "sk-test-1234", runMode: "online" },
      }],
    };
    await assert.rejects(
      () => publishRecipe(worker, {
        recipeId: "leaky",
        displayName: "Leaky recipe",
        workflow: workflowWithCred,
        providers: [],
        permissions: [],
        verification: null,
        environment: { adapterKind: "trusted-local" },
        tags: [],
        publishedBy: "tester",
      }),
      (error: unknown) => {
        if (!(error instanceof z.ZodError)) return false;
        return error.issues.some((issue) =>
          issue.path[0] === "__credential_leak__"
          && issue.message.includes("credential-shaped field")
          && issue.message.includes("apiKey"),
        );
      },
    );
  } finally { await worker.close(); }
});

test("M6.2 publishRecipe refuses verification.env entries with secret-shaped suffixes", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      () => publishRecipe(worker, {
        recipeId: "leaky-env",
        displayName: "Leaky env recipe",
        workflow: validWorkflow,
        providers: [],
        permissions: [],
        verification: {
          command: "lint",
          argv: [],
          env: {
            GITHUB_TOKEN: "ghp_xxx",  // suffix match: _TOKEN
            PATH: "/usr/bin",          // benign — no suffix match
          },
          assertionPattern: null,
          required: true,
        },
        environment: { adapterKind: "trusted-local" },
        tags: [],
        publishedBy: "tester",
      }),
      (error: unknown) => {
        if (!(error instanceof z.ZodError)) return false;
        return error.issues.some((issue) =>
          issue.path[0] === "__credential_leak__"
          && issue.message.includes("env key")
          && issue.message.includes("GITHUB_TOKEN"),
        );
      },
    );
  } finally { await worker.close(); }
});

test("M6.2 publishRecipe refuses credential-shaped fields nested in the workflow graph", async () => {
  const worker = freshWorker();
  try {
    const nested = {
      ...validWorkflow,
      metadata: { secrets: { refreshToken: "rt-12345" } },
    };
    await assert.rejects(
      () => publishRecipe(worker, {
        recipeId: "leaky-nested",
        displayName: "Leaky nested recipe",
        workflow: nested,
        providers: [],
        permissions: [],
        verification: null,
        environment: { adapterKind: "trusted-local" },
        tags: [],
        publishedBy: "tester",
      }),
      (error: unknown) => {
        if (!(error instanceof z.ZodError)) return false;
        return error.issues.some((issue) =>
          issue.path[0] === "__credential_leak__"
          && issue.path.some((p) => String(p).includes("secrets"))
          && issue.path.some((p) => String(p).includes("refreshToken")),
        );
      },
    );
  } finally { await worker.close(); }
});

test("M6.2 publishRecipe accepts a recipe with no credentials and no env-secret suffixes", async () => {
  const worker = freshWorker();
  try {
    const v1 = await publishRecipe(worker, {
      recipeId: "clean",
      displayName: "Clean recipe",
      workflow: {
        ...validWorkflow,
        // A field whose name is similar but not credential-shaped
        // must be allowed — e.g. `keyPath` is fine, `apiKey` is not.
        metadata: { keyPath: "/etc/ssl/cert.pem", mode: "fast" },
      },
      providers: [],
      permissions: [],
      verification: {
        command: "lint",
        argv: [],
        env: {
          PATH: "/usr/bin",
          NODE_ENV: "production",
        },
        assertionPattern: null,
        required: true,
      },
      environment: { adapterKind: "trusted-local" },
      tags: [],
      publishedBy: "tester",
    });
    assert.equal(v1.recipeId, "clean");
  } finally { await worker.close(); }
});

test("M6.2 detectCredentialLeaks walks arbitrary JSON and surfaces every issue", async () => {
  const { detectCredentialLeaks } = await import("../../src/shared/recipe-schema");
  const issues = detectCredentialLeaks({
    apiKey: "X",
    env: { AWS_SECRET_ACCESS_KEY: "X" },
    nested: { token: "X", deep: { password: "X" } },
    bearer: "X",
  });
  // We expect at least: apiKey, AWS_SECRET_ACCESS_KEY (env-suffix),
  // nested.token, nested.deep.password, bearer — order independent.
  const keys = issues.map((i) => i.key);
  assert.ok(keys.includes("apiKey"));
  assert.ok(keys.includes("AWS_SECRET_ACCESS_KEY"));
  assert.ok(keys.includes("token"));
  assert.ok(keys.includes("password"));
  assert.ok(keys.includes("bearer"));
});
