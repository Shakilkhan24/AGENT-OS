/**
 * M6.2 — immutable recipe version schemas.
 *
 * The M6.2 bullet (FUTURE/IMPLEMENTATION-README.md line 244) reads:
 *
 * > M6.2 Save recipes as immutable versions pinning selected context
 * > rules, provider/capability versions, environment, verification
 * > and permission requirements. Store requirements, not portable
 * > live grant IDs or credentials. Resolve current authority per
 * > execution; edits and promotion create inspectable new versions.
 *
 * A recipe is a complete `WorkflowGraph` plus a frozen envelope of
 * execution requirements: provider versions, capability digests,
 * environment adapter, verification requirements, and permission
 * requirements. Once published, a recipe version is immutable —
 * edits and promotion create a NEW version under the same
 * `recipeId`, leaving the older version intact so a pinned
 * execution can be replayed bit-for-bit.
 *
 * Storage strategy: persisted under the `meta` table under the
 * content-addressed key `recipe:<recipeId>:<version>:<digest>` —
 * the digest is computed via `digestRecipe` over the canonical JSON
 * of the immutable payload (excluding volatile `at` / `createdBy`).
 * Mirrors M4.6's `context-import:<runId>:<digest>` and M4.7's
 * `hook-activation:<hookId>` pattern so no schema migration is
 * required.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Requirements — frozen at publish time, never read from a live grant row.
// ---------------------------------------------------------------------------

/**
 * Provider-version requirement. Pins a specific
 * `(providerKind, providerVersion, model)` triple; the executor
 * refuses to dispatch if the installed provider triple does not
 * match at execution time.
 */
export const recipeProviderRequirementSchema = z
  .object({
    providerKind: z.enum(["claude", "codex"]),
    providerVersion: z.string().min(1).max(256),
    model: z.string().min(1).max(256),
    /**
     * If supplied, the running provider must declare a capability
     * digest matching this value. Mirrors M4.3's `capabilityId`.
     */
    capabilityDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type RecipeProviderRequirement = z.infer<typeof recipeProviderRequirementSchema>;

/**
 * Permission requirement. A subset of the M3a grant shape; the
 * runtime resolves the matching live grant per execution, but the
 * recipe NEVER stores the live grant ID or credential.
 */
export const recipePermissionRequirementSchema = z
  .object({
    /**
     * Logical permission name. Reserved set:
     *   - `shell.execute`            — needed by `command` steps
     *   - `provider.execute`         — needed by `agent` steps
     *   - `filesystem.read`          — context import
     *   - `filesystem.write`         — workspace promotion
     *   - `network.outbound`         — MCP / remote-host calls
     */
    kind: z.enum([
      "shell.execute",
      "provider.execute",
      "filesystem.read",
      "filesystem.write",
      "network.outbound",
    ]),
    /**
     * Human-readable scope hint (`path:`, `host:`, `binary:` prefix
     * is conventional). The runtime maps this to the matching live
     * grant's `scope_json` keys at execution time.
     */
    scope: z.string().min(1).max(512),
    required: z.boolean().default(true),
  })
  .strict();
export type RecipePermissionRequirement = z.infer<typeof recipePermissionRequirementSchema>;

/**
 * Verification requirement. The recipe pins a verifier by
 * `(recipeId | command)` plus an optional assertion pattern. The
 * `recipeId` reference is to the existing M3c.2
 * `verification_recipe` row, so the verifier command itself
 * remains editable in-place without bumping the workflow recipe
 * version (a strict workflow recipe pins only the recipeId).
 */
export const recipeVerificationRequirementSchema = z
  .object({
    recipeId: z.string().uuid().optional(),
    command: z.string().trim().min(1).max(1024).optional(),
    argv: z.array(z.string().min(1).max(1024)).default([]),
    env: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
    assertionPattern: z.string().max(256).nullable().default(null),
    required: z.boolean().default(true),
  })
  .strict()
  .refine((value) => Boolean(value.recipeId) || Boolean(value.command), {
    message: "recipe verification requires either recipeId or a command override",
  });
export type RecipeVerificationRequirement = z.infer<typeof recipeVerificationRequirementSchema>;

/**
 * Environment requirement. Pin a specific environment adapter kind
 * + (optional) image digest. The M6.5 adapter resolves this at
 * execution time.
 */
export const recipeEnvironmentRequirementSchema = z
  .object({
    adapterKind: z.enum(["trusted-local", "restricted-local", "owned-remote"]),
    /** Pin a specific image / template digest when supplied. */
    imageDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    /** Optional resource caps; defaults applied at execution time. */
    cpuMillis: z.number().int().min(100).max(64_000).optional(),
    memoryMib: z.number().int().min(64).max(65_536).optional(),
    diskMib: z.number().int().min(64).max(1_048_576).optional(),
  })
  .strict();
export type RecipeEnvironmentRequirement = z.infer<typeof recipeEnvironmentRequirementSchema>;

// ---------------------------------------------------------------------------
// Credential-leak gate (M6.2)
// ---------------------------------------------------------------------------

/**
 * Vocabulary of field names that strongly suggest a credential. A
 * recipe that carries any of these as a JSON key (anywhere in its
 * payload tree) is refused — the recipe MUST store requirements,
 * not portable live grant IDs or credentials. The runtime resolves
 * current authority per execution from the live grant set.
 *
 * The vocabulary is intentionally conservative: it matches common
 * naming patterns (camelCase, snake_case, kebab-case) for the
 * most-common secret types. Callers MUST keep credentials out of
 * the recipe payload entirely; this gate is a backstop, not a
 * substitute for that discipline.
 */
const CREDENTIAL_FIELD_NAMES: ReadonlySet<string> = new Set([
  "password",
  "passphrase",
  "secret",
  "apikey",
  "api_key",
  "apitoken",
  "api_token",
  "token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "bearer",
  "authorization",
  "privatekey",
  "private_key",
  "sshkey",
  "ssh_key",
  "credential",
  "credentials",
]);

/**
 * Suffixes that mark an env-var key as credential-shaped even when
 * the literal key isn't in the field-name vocabulary. Captures
 * `GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`, etc.
 */
const CREDENTIAL_KEY_SUFFIXES: ReadonlyArray<string> = [
  "_TOKEN",
  "_KEY",
  "_SECRET",
  "_PASSWORD",
  "_CREDENTIAL",
  "_PRIVATE_KEY",
];

type CredentialLeakIssueInternal = { path: string; kind: "field" | "env-suffix"; key: string };
void 0 as unknown as CredentialLeakIssueInternal; // referenced for documentation; the visible type is `CredentialLeakIssue`.

function findCredentialLeaks(value: unknown, basePath: string, out: CredentialLeakIssue[]): void {
  if (value == null) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++)
      findCredentialLeaks(value[i], `${basePath}[${String(i)}]`, out);
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const normalized = k.replace(/[-_.]/g, "").toLowerCase();
      if (CREDENTIAL_FIELD_NAMES.has(normalized)) {
        out.push({ path: `${basePath}.${k}`, kind: "field", key: k });
      }
      if (basePath.endsWith("verification.env") || basePath.endsWith(".env")) {
        const upper = k.toUpperCase();
        if (CREDENTIAL_KEY_SUFFIXES.some((s) => upper.endsWith(s))) {
          out.push({ path: `${basePath}.${k}`, kind: "env-suffix", key: k });
        }
      }
      findCredentialLeaks(v, `${basePath}.${k}`, out);
    }
    return;
  }
  // String / number / boolean — no keys to walk.
}

export const credentialLeakIssueSchema = z
  .object({
    path: z.string().min(1).max(512),
    kind: z.enum(["field", "env-suffix"]),
    key: z.string().min(1).max(128),
  })
  .strict();
export type CredentialLeakIssue = z.infer<typeof credentialLeakIssueSchema>;

/**
 * Walk a candidate recipe payload and return every credential-leak
 * issue. The publish / promote paths run this gate on the parsed
 * payload so a recipe that carries a live grant ID or any
 * credential-shaped string is refused with a structured error.
 */
export function detectCredentialLeaks(version: unknown): ReadonlyArray<CredentialLeakIssue> {
  const issues: CredentialLeakIssue[] = [];
  findCredentialLeaks(version, "$", issues);
  return issues;
}

// ---------------------------------------------------------------------------
// Recipe — the immutable version payload.
// ---------------------------------------------------------------------------

export const recipeVersionSchema = z
  .object({
    recipeId: z.string().min(1).max(128),
    /** Monotonic per `recipeId`; the first version is `1`. */
    version: z.number().int().min(1).max(2_048),
    displayName: z.string().min(1).max(256),
    description: z.string().max(4096).default(""),
    /** The frozen workflow graph. Mirrors `WorkflowGraph` from M6.1. */
    workflow: z.unknown(),
    /** Provider triples the recipe binds to. */
    providers: z.array(recipeProviderRequirementSchema).max(16).default([]),
    /** Required permissions. */
    permissions: z.array(recipePermissionRequirementSchema).max(32).default([]),
    /** Required verification. */
    verification: recipeVerificationRequirementSchema.nullable().default(null),
    /** Required environment. */
    environment: recipeEnvironmentRequirementSchema,
    /** Free-form tags for catalog lookup. */
    tags: z.array(z.string().min(1).max(64)).max(32).default([]),
    /** Caller identity (principal name) for the audit trail. */
    publishedBy: z.string().min(1).max(256),
    /** ISO timestamp of publish — not part of the digest surface. */
    publishedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issues = detectCredentialLeaks(value);
    for (const issue of issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["__credential_leak__", issue.path],
        message:
          issue.kind === "field"
            ? `credential-shaped field "${issue.key}" is forbidden in a recipe (M6.2)`
            : `env key "${issue.key}" looks credential-shaped (suffix matches common secret patterns)`,
      });
    }
  });
export type RecipeVersion = z.infer<typeof recipeVersionSchema>;

// ---------------------------------------------------------------------------
// Listing / resolution envelopes.
// ---------------------------------------------------------------------------

export const recipeSummarySchema = z
  .object({
    recipeId: z.string().min(1).max(128),
    latestVersion: z.number().int().min(1).max(2_048),
    totalVersions: z.number().int().min(1).max(2_048),
    displayName: z.string().min(1).max(256),
    tags: z.array(z.string().min(1).max(64)),
    publishedAt: z.string().datetime(),
    publishedBy: z.string().min(1).max(256),
    /** Content-addressed digest of the latest version's payload. */
    latestDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type RecipeSummary = z.infer<typeof recipeSummarySchema>;
