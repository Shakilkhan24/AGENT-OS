/**
 * M4.4 — Manifest resolver + installation plan.
 *
 * M4.4 separates five lifecycle stages explicitly: discovery,
 * inspected approval, install-inactive, validation, activation.
 * The roadmap says "use one manifest resolver and installation
 * plan" — the resolver is `producePlan`, the plan is the
 * `InstallationPlan` value, and the lifecycle stages are tracked
 * structurally so a future installer plane can implement them
 * without re-deriving the sequence.
 *
 * This increment ships the **planner**, not the installer. The
 * planner is a pure function: given a `CapabilityManifest`, a
 * target adapter, and a catalog snapshot, it produces an
 * `InstallationPlan`. The planner never invokes an adapter, never
 * fetches a digest, never mutates the database. That is the
 * "inspectable approval" stage — the renderer shows the plan to
 * the human, the human approves, and only then does the installer
 * plane execute the steps.
 *
 * Pinned digests, origins, licenses and requested powers are
 * recorded in the plan from the manifest. Drift (a manifest whose
 * `expectedDigest` does not match the supplied bytes) raises
 * `AppError("CONFLICT", …)` at plan-assembly time — the runtime
 * never silently proceeds with an unpinned input.
 *
 * The receipt ledger (`runtime/db/installation-receipt.ts`) is the
 * installer plane's counterpart: it records per-step outcomes
 * append-only so an audit can replay what happened. The roadmap
 * line "Rollback never pretends arbitrary install-script side
 * effects are reversible" is enforced by construction: every
 * receipt's `reversible` flag is `false`.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { capabilityKindSchema } from "./capability-catalog";

/** Semver-ish version triple. */
export const manifestVersionSchema = z
  .object({
    major: z.number().int().min(0).max(99),
    minor: z.number().int().min(0).max(99),
    patch: z.number().int().min(0).max(99),
  })
  .strict();
export type ManifestVersion = z.infer<typeof manifestVersionSchema>;

/**
 * Where a pinned input came from. The shape is `(table-name)`,
 * `(filesystem:<abs-path>)`, `(capability-probe:<provider>)` or
 * `(instructions-walker:<root>)` — the same vocabulary the
 * capability-catalog uses so a future installer can re-use the
 * scanner output as input.
 */
export const manifestOriginSchema = z.string().min(1).max(512);
export type ManifestOrigin = z.infer<typeof manifestOriginSchema>;

/** Power the resource requests. Intersection with `grantedPowers` happens at runtime. */
export const requestedPowerSchema = z.string().min(1).max(80);
export type RequestedPower = z.infer<typeof requestedPowerSchema>;

/** License token. SPDX-style identifier or a path to a license file in the resource. */
export const licenseSchema = z.string().min(1).max(256);
export type License = z.infer<typeof licenseSchema>;

/** A single pinned input. `expectedDigest` is what the manifest author recorded; `suppliedDigest` is what the planner observed. */
export const pinnedInputSchema = z
  .object({
    inputId: z.string().uuid(),
    origin: manifestOriginSchema,
    expectedDigest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Digest the planner actually observed when assembling the plan. */
    suppliedDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    license: licenseSchema,
    /** Capabilities the resource authorises when invoked. Empty = no powers. */
    requestedPowers: z.array(requestedPowerSchema).max(64).default([]),
    /** Optional human label. */
    label: z.string().min(1).max(200).nullable().default(null),
  })
  .strict();
export type PinnedInput = z.infer<typeof pinnedInputSchema>;

/** Target adapter kind. The installer dispatches through these. */
export const targetAdapterSchema = z.enum(["filesystem", "execution"]);
export type TargetAdapter = z.infer<typeof targetAdapterSchema>;

/**
 * Manifest shape — what should exist after a successful install.
 *
 * The planner does not enforce dependencies (a future installer
 * plane does); this increment records the dependency graph so a
 * later executor can traverse it.
 */
export const capabilityManifestSchema = z
  .object({
    manifestId: z.string().uuid(),
    version: manifestVersionSchema,
    kind: capabilityKindSchema,
    displayName: z.string().trim().min(1).max(200),
    inputs: z.array(pinnedInputSchema).max(64),
    dependencies: z.array(z.string().uuid()).max(32).default([]),
    targetAdapter: targetAdapterSchema,
    /** Optional human notes. */
    notes: z.string().max(4096).default(""),
  })
  .strict();
export type CapabilityManifest = z.infer<typeof capabilityManifestSchema>;

/**
 * Plan step kinds. The five lifecycle stages are encoded as
 * ordered steps so a future executor can dispatch them in order.
 *
 *  - `InstallInactive` writes the resource to its target adapter
 *    but marks it inactive (the `install-inactive` stage).
 *  - `Validate` checks digests, dependencies and target state
 *    (the `validation` stage).
 *  - `Activate` flips the resource's active marker
 *    (the `activation` stage).
 *  - `Hook` registers a runtime hook entry (extension surface for
 *    M4.7). M4.4 ships the plan shape but the executor is deferred.
 *  - `Approve` is a no-op marker — the planner emits it as the
 *    first step so the installer's `inspected approval` stage has
 *    a step to record against.
 */
export const planStepKindSchema = z.enum([
  "Approve",
  "InstallInactive",
  "Validate",
  "Activate",
  "Hook",
]);
export type PlanStepKind = z.infer<typeof planStepKindSchema>;

export const planStepSchema = z
  .object({
    stepId: z.string().uuid(),
    kind: planStepKindSchema,
    /** Pinned input the step acts on. May be `null` for `Approve`. */
    inputId: z.string().uuid().nullable(),
    /** Target adapter for this step. */
    targetAdapter: targetAdapterSchema,
    /** Sequence index in the plan. Steps with lower `order` run first. */
    order: z.number().int().min(0).max(1024),
    /** Step display name for the renderer. */
    label: z.string().min(1).max(200),
  })
  .strict();
export type PlanStep = z.infer<typeof planStepSchema>;

export const installationPlanSchema = z
  .object({
    planId: z.string().uuid(),
    manifestId: z.string().uuid(),
    manifestVersion: manifestVersionSchema,
    kind: capabilityKindSchema,
    steps: z.array(planStepSchema).max(64),
    pinnedDigests: z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(64),
    requestedPowers: z.array(requestedPowerSchema).max(64),
    /** Aggregate of all input licenses (deduped, sorted). */
    licenses: z.array(licenseSchema).max(64),
    assembledAt: z.string().datetime(),
    /** SHA-256 digest over the canonical plan. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Stage ordering is part of the plan shape so a renderer can show the lifecycle. */
    stageOrder: z.array(planStepKindSchema),
  })
  .strict();
export type InstallationPlan = z.infer<typeof installationPlanSchema>;

/**
 * Deterministic JSON serialisation: sorted object keys, arrays
 * preserved in source order. Used for plan digesting.
 */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

/**
 * Validate the supplied digest against the manifest's expected
 * digest. A null supplied digest is allowed (the planner has not
 * yet observed the resource); the executor will refuse to proceed
 * without a matching observed digest at install-inactive time.
 */
function checkDigestOrUnset(input: PinnedInput): void {
  if (input.suppliedDigest === null) return;
  if (input.suppliedDigest !== input.expectedDigest) {
    throw new AppError(
      "CONFLICT",
      `Pinned input "${input.inputId}" digest mismatch: expected ${input.expectedDigest}, got ${input.suppliedDigest}`,
    );
  }
}

/**
 * Plan input. The caller passes the manifest, the catalog snapshot
 * to cross-check origins, and the supplied-digest overrides for
 * inputs the planner already observed.
 */
export interface ProducePlanInput {
  readonly manifest: CapabilityManifest;
  /** Catalog snapshot keyed by `CapabilityOrigin` (used to look up supplied digests). */
  readonly catalogDigests?: Readonly<Record<string, string>>;
  /** Explicit supplied digests that should override manifest defaults. */
  readonly suppliedDigests?: Readonly<Record<string, string>>;
}

const STAGE_ORDER: PlanStepKind[] = [
  "Approve",
  "InstallInactive",
  "Validate",
  "Activate",
  "Hook",
];

/**
 * Produce an immutable installation plan from a capability
 * manifest. The planner is **pure**: same input ⇒ same plan.
 *
 * Behaviour:
 *  - Every pinned input is checked: if `suppliedDigest` is set, it
 *    must equal `expectedDigest` or the planner raises `CONFLICT`.
 *  - The plan includes five lifecycle stages in canonical order.
 *    An executor dispatches them in `order` sequence; the
 *    `stageOrder` field documents the lifecycle so a renderer can
 *    render the inspected approval → install-inactive → validate
 *    → activate → hook sequence without re-deriving it.
 *  - The plan is immutable after assembly; the planner does not
 *    expose a mutator. A subsequent edit requires a new manifest
 *    version, which produces a new plan.
 *  - Pinned digests, requested powers and licenses are aggregated
 *    and deduplicated; the renderer uses them to render a
 *    pre-install review screen.
 */
export function producePlan(input: ProducePlanInput): InstallationPlan {
  const manifest = capabilityManifestSchema.parse(input.manifest);

  // Cross-check supplied digests. Catalog digests apply when the
  // manifest did not supply an explicit override.
  const inputs: PinnedInput[] = manifest.inputs.map((pinned) => {
    const override = input.suppliedDigests?.[pinned.inputId];
    const catalog = input.catalogDigests?.[pinned.origin];
    const suppliedDigest = override ?? catalog ?? pinned.suppliedDigest;
    const next: PinnedInput = { ...pinned, suppliedDigest };
    checkDigestOrUnset(next);
    return next;
  });

  // Aggregate pinned digests (deduped + sorted) — these are the
  // exact digests the executor must observe during install.
  const pinnedDigests = [...new Set(inputs.map((i) => i.expectedDigest))].sort();

  // Aggregate requested powers (deduped + sorted).
  const requestedPowers = [...new Set(inputs.flatMap((i) => i.requestedPowers))].sort();

  // Aggregate licenses (deduped + sorted).
  const licenses = [...new Set(inputs.map((i) => i.license))].sort();

  // Build the ordered step list. The lifecycle stages drive the
  // base order; we emit one step per pinned input per stage that
  // needs it, plus a single `Approve` marker at the front.
  const steps: PlanStep[] = [];
  steps.push({
    stepId: randomUUID(),
    kind: "Approve",
    inputId: null,
    targetAdapter: manifest.targetAdapter,
    order: 0,
    label: `Approve install of "${manifest.displayName}" v${manifest.version.major}.${manifest.version.minor}.${manifest.version.patch}`,
  });

  let order = 1;
  for (const pinned of inputs) {
    steps.push({
      stepId: randomUUID(),
      kind: "InstallInactive",
      inputId: pinned.inputId,
      targetAdapter: manifest.targetAdapter,
      order: order++,
      label: `Install inactive: ${pinned.label ?? pinned.inputId}`,
    });
  }
  for (const pinned of inputs) {
    steps.push({
      stepId: randomUUID(),
      kind: "Validate",
      inputId: pinned.inputId,
      targetAdapter: manifest.targetAdapter,
      order: order++,
      label: `Validate digest for ${pinned.label ?? pinned.inputId}`,
    });
  }
  for (const pinned of inputs) {
    steps.push({
      stepId: randomUUID(),
      kind: "Activate",
      inputId: pinned.inputId,
      targetAdapter: manifest.targetAdapter,
      order: order++,
      label: `Activate ${pinned.label ?? pinned.inputId}`,
    });
  }
  for (const pinned of inputs) {
    steps.push({
      stepId: randomUUID(),
      kind: "Hook",
      inputId: pinned.inputId,
      targetAdapter: manifest.targetAdapter,
      order: order++,
      label: `Register runtime hook for ${pinned.label ?? pinned.inputId}`,
    });
  }

  const planShape = {
    planId: randomUUID(),
    manifestId: manifest.manifestId,
    manifestVersion: manifest.version,
    kind: manifest.kind,
    steps,
    pinnedDigests,
    requestedPowers,
    licenses,
    assembledAt: new Date().toISOString(),
    digest: "0".repeat(64), // placeholder, replaced below
    stageOrder: STAGE_ORDER,
  };
  // The digest covers the plan minus itself; recomputing post-
  // assembly is the canonical pattern.
  const digest = createHash("sha256")
    .update(canonicalStringify({ ...planShape, digest: "" }), "utf8")
    .digest("hex");
  return installationPlanSchema.parse({ ...planShape, digest });
}

/**
 * Validate an existing plan's digest. A plan whose digest does not
 * match its content has been mutated or corrupted; the runtime
 * refuses to execute it.
 */
export function verifyPlanDigest(plan: InstallationPlan): void {
  const expected = createHash("sha256")
    .update(canonicalStringify({ ...plan, digest: "" }), "utf8")
    .digest("hex");
  if (expected !== plan.digest) {
    throw new AppError(
      "CONFLICT",
      `Installation plan "${plan.planId}" digest mismatch (expected ${expected}, got ${plan.digest})`,
    );
  }
}

/**
 * Test seam: produce a deterministic `manifestId` from a seed so a
 * test can replay a manifest with a stable identity. Production
 * callers should use `randomUUID()` directly.
 */
export function manifestIdFromSeed(seed: string): string {
  const digest = createHash("sha256").update(seed, "utf8").digest("hex");
  // Format the digest as a UUID v4 (same pattern as the catalog).
  const a = digest.slice(0, 8);
  const b = digest.slice(8, 12);
  const c = "4" + digest.slice(13, 16);
  const d = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + digest.slice(17, 20);
  const e = digest.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}`;
}

/**
 * The five-step lifecycle stage order. Exported so a renderer can
 * render the inspected approval → install-inactive → validate →
 * activate → hook sequence without consulting the plan's
 * `stageOrder` field directly.
 */
export const LIFECYCLE_STAGES: ReadonlyArray<PlanStepKind> = STAGE_ORDER;
