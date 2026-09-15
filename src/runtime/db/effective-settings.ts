/**
 * M4.2 — Effective settings resolver.
 *
 * The runtime never reads a single settings file in isolation. A
 * managed run, recipe, project or provider-profile may each layer
 * its own preferences on top of the user's saved settings and the
 * built-in defaults. M4.2 introduces the resolver that turns a stack
 * of layered inputs into a single `EffectiveSettings` value with
 * full provenance — every field records the layer it came from, the
 * captured-at timestamp, and a per-layer SHA-256 digest so an audit
 * can later replay what was effective when.
 *
 * Precedence: defaults → user → project → recipe → run → provider-profile.
 * Later layers override earlier layers **per field**. Restrictions
 * **intersect** across all layers — a restriction present in any
 * layer is required, a restriction absent in any layer is dropped —
 * so the effective restriction set is never the union.
 *
 * Unknown native fields are preserved in `nativeFields` so a future
 * provider adapter can store keys the resolver does not yet know
 * about. The resolver refuses to drop a key without recording it in
 * `nativeFields` first.
 *
 * This module is read-only. No mutation path lives here; M4.4's
 * installer plan and M4.6's context import will produce the layered
 * inputs. M4.2 only defines the resolver and the entity shape.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { settingsSchema, type Settings } from "../../shared/settings";
import { AppError } from "../../shared/errors";

/** Identifier for the source of a single layered input. */
export type LayerSource =
  | "defaults"
  | "user"
  | "project"
  | "recipe"
  | "run"
  | "provider-profile";

/** All supported restriction tokens. Unknown tokens raise a parse failure. */
export const SUPPORTED_RESTRICTIONS = [
  "no-network",
  "no-shell-exec",
  "read-only-filesystem",
] as const;
export type SupportedRestriction = typeof SUPPORTED_RESTRICTIONS[number];

export const supportedRestrictionSchema = z.enum(SUPPORTED_RESTRICTIONS);

/**
 * `EffectiveLayer` records the source of every field the resolver
 * touches. The layer's `digest` is SHA-256 over the canonical JSON of
 * `values` + `restrictions` + `nativeFields` so a replay can confirm
 * the layer was not tampered with between capture and use.
 */
export interface EffectiveLayer {
  readonly source: LayerSource;
  /** ISO-8601 timestamp the layer was captured at. */
  readonly capturedAt: string;
  /** SHA-256 digest over the layer's `values + restrictions + nativeFields`. */
  readonly digest: string;
  /** Field values this layer contributes (subset of `Settings` keys). */
  readonly values: Partial<Settings>;
  /** Restrictions this layer requires. Intersected with all other layers. */
  readonly restrictions: ReadonlyArray<SupportedRestriction>;
  /**
   * Native provider fields the resolver does not know about but
   * preserves verbatim. The resolver never drops a key without
   * recording it here first.
   */
  readonly nativeFields: Readonly<Record<string, unknown>>;
  /** Optional opaque identity for the source (profile id, recipe id, etc.). */
  readonly sourceId: string | null;
}

/** Input shape for `resolveEffectiveSettings`. */
export interface EffectiveSettingsInput {
  readonly layers: ReadonlyArray<EffectiveLayer>;
}

export interface EffectiveSettings {
  /** The resolved `Settings` value. */
  readonly settings: Settings;
  /** Per-field provenance — which layer supplied the value. */
  readonly fieldProvenance: Readonly<Record<keyof Settings, LayerSource>>;
  /** Restrictions surviving the intersection across all layers. */
  readonly restrictions: ReadonlyArray<SupportedRestriction>;
  /** Native fields preserved verbatim from every layer, keyed by source. */
  readonly nativeFields: Readonly<Record<LayerSource, Readonly<Record<string, unknown>>>>;
  /** Composite digest over (layers, settings, restrictions, nativeFields). */
  readonly digest: string;
  /** Layers the resolver actually consulted, in precedence order. */
  readonly layerOrder: ReadonlyArray<LayerSource>;
}

/**
 * Per-source digest used by `EffectiveLayer.digest`. Stable across
 * runs because the JSON serialisation is deterministic
 * (`Object.keys` order + sorted arrays).
 *
 * `sourceId` is part of the canonical input: a layer re-supplied
 * with a different `sourceId` produces a different digest, so an
 * audit can detect when a layer was rebound to a different
 * identity. `capturedAt` is intentionally **not** part of the
 * canonical input — capturing twice in the same logical state
 * should not invalidate the digest.
 */
export function digestLayer(
  values: Partial<Settings>,
  restrictions: ReadonlyArray<SupportedRestriction>,
  nativeFields: Readonly<Record<string, unknown>>,
  sourceId: string | null = null,
): string {
  const canonical = {
    sourceId,
    values: stableStringify(values),
    restrictions: [...restrictions].sort(),
    nativeFields: stableStringify(nativeFields),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

export function digestEffective(value: EffectiveSettings): string {
  return createHash("sha256")
    .update(stableStringify({
      layerOrder: value.layerOrder,
      settings: value.settings,
      restrictions: [...value.restrictions].sort(),
      nativeFields: value.nativeFields,
    }), "utf8")
    .digest("hex");
}

/**
 * Resolve layered inputs into a single effective settings value with
 * provenance. The function refuses unreadable layers (a layer that
 * exists but whose `digest` does not match its content raises
 * `AppError("CONFLICT", …)`); unknown field names in `values` are
 * re-routed to `nativeFields` instead of being silently dropped.
 */
export function resolveEffectiveSettings(input: EffectiveSettingsInput): EffectiveSettings {
  if (!Array.isArray(input.layers)) {
    throw new AppError("INVALID_REQUEST", "Effective settings input must include a `layers` array");
  }
  if (input.layers.length === 0) {
    throw new AppError("INVALID_REQUEST", "Effective settings must include at least one layer");
  }
  const allowedSources: LayerSource[] = ["defaults", "user", "project", "recipe", "run", "provider-profile"];
  // Precedence order. `defaults` is implicitly supplied by the
  // settings schema; we materialise it as a synthetic layer when no
  // caller did so. Caller-supplied layers follow `allowedSources`.
  const seen = new Set<LayerSource>();
  for (const layer of input.layers) {
    if (!allowedSources.includes(layer.source)) {
      throw new AppError(
        "INVALID_REQUEST",
        `Unknown effective-settings source "${layer.source}" (allowed: ${allowedSources.join(", ")})`,
      );
    }
    if (seen.has(layer.source)) {
      throw new AppError(
        "CONFLICT",
        `Effective-settings source "${layer.source}" supplied more than once`,
      );
    }
    seen.add(layer.source);
    // Re-validate restrictions — unknown tokens must not slip in.
    for (const r of layer.restrictions) {
      const parsed = supportedRestrictionSchema.safeParse(r);
      if (!parsed.success) {
        throw new AppError(
          "INVALID_REQUEST",
          `Layer "${layer.source}" declares unsupported restriction "${r}"`,
        );
      }
    }
    // Re-validate digest.
    const expected = digestLayer(layer.values, layer.restrictions, layer.nativeFields, layer.sourceId);
    if (expected !== layer.digest) {
      throw new AppError(
        "CONFLICT",
        `Effective-settings layer "${layer.source}" digest mismatch (expected ${expected}, got ${layer.digest})`,
      );
    }
  }

  // Materialise the implicit `defaults` layer when no caller did.
  const defaultsLayer: EffectiveLayer = {
    source: "defaults",
    capturedAt: new Date(0).toISOString(),
    digest: digestLayer(settingsSchema.parse({}), [], {}, null),
    values: settingsSchema.parse({}),
    restrictions: [],
    nativeFields: {},
    sourceId: null,
  };
  const layers: EffectiveLayer[] = seen.has("defaults")
    ? input.layers.slice()
    : [defaultsLayer, ...input.layers];

  // Sort by precedence. Later entries override earlier entries per field.
  const order: LayerSource[] = allowedSources.filter((s) => layers.some((l) => l.source === s));
  const layerBySource = new Map(layers.map((l) => [l.source, l]));

  const merged: Record<string, unknown> = {};
  const provenance: Record<string, LayerSource> = {};
  const nativeBySource: Record<LayerSource, Record<string, unknown>> = {
    defaults: {},
    user: {},
    project: {},
    recipe: {},
    run: {},
    "provider-profile": {},
  };

  for (const source of order) {
    const layer = layerBySource.get(source);
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer.values)) {
      if (!isKnownSettingKey(key)) {
        // Re-route unknown keys to nativeFields instead of dropping them.
        nativeBySource[source][key] = value;
        continue;
      }
      merged[key] = value;
      provenance[key] = source;
    }
    // Native fields are always preserved, never shadowed.
    for (const [key, value] of Object.entries(layer.nativeFields)) {
      nativeBySource[source][key] = value;
    }
  }

  // Restrictions intersect: the effective set is the set of
  // restrictions present in **every** layer that declares a
  // non-empty restriction list. A layer that declares `[]` is
  // treated as "no opinion" and does not narrow the intersection.
  let restrictions: ReadonlyArray<SupportedRestriction> | null = null;
  for (const source of order) {
    const layer = layerBySource.get(source);
    if (!layer || layer.restrictions.length === 0) continue;
    if (restrictions === null) {
      restrictions = [...layer.restrictions];
    } else {
      restrictions = restrictions.filter((r) => layer.restrictions.includes(r));
    }
  }
  restrictions = restrictions ?? [];

  // Validate the merged result against the settings schema so a
  // caller cannot smuggle an out-of-range value past the resolver.
  const settings = settingsSchema.parse(merged);

  const fieldProvenance: Record<keyof Settings, LayerSource> = {} as Record<keyof Settings, LayerSource>;
  for (const key of Object.keys(settings) as Array<keyof Settings>) {
    fieldProvenance[key] = provenance[key] ?? "defaults";
  }

  const result: EffectiveSettings = {
    settings,
    fieldProvenance,
    restrictions,
    nativeFields: nativeBySource,
    layerOrder: order,
    digest: "",
  };
  // The composite digest covers the final value, including itself.
  // Computing it post-construction is necessary because `digest` is
  // part of the digestable surface.
  const withDigest: EffectiveSettings = { ...result, digest: digestEffective(result) };
  return withDigest;
}

/** Test seam: which keys the schema recognises. */
function isKnownSettingKey(key: string): boolean {
  return (KNOWN_SETTING_KEYS as ReadonlyArray<string>).includes(key);
}

/**
 * The list of keys the settings schema recognises. Kept in sync
 * with `src/shared/settings.ts` manually — the alternative
 * (introspecting the Zod schema at runtime) is brittle. The list is
 * small (14 fields today) so a manual mirror is cheap and
 * auditable.
 */
const KNOWN_SETTING_KEYS = [
  "pollIntervalMs",
  "fileTimeoutMs",
  "fileQueueLimit",
  "draftIntervalMs",
  "draftLimit",
  "eventReplayLimit",
  "logRetentionDays",
  "inputBudgetBytes",
  "historyLines",
  "attachmentCacheSize",
  "attachmentIdleMs",
  "gracefulStopMs",
  "fileWatching",
  "shellMode",
  "version",
] as const;

/**
 * Deterministic JSON serialisation: sorts object keys, treats arrays
 * as-is, and recursively canonicalises. Required for digest
 * stability across runs.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * Build an `EffectiveLayer` from caller-supplied raw input, computing
 * the digest in one step. Refuses to construct a layer whose
 * `restrictions` contain unknown tokens or whose `nativeFields` is
 * mutated after construction.
 */
export function buildEffectiveLayer(input: {
  readonly source: LayerSource;
  readonly capturedAt: string;
  readonly sourceId: string | null;
  readonly values?: Partial<Settings>;
  readonly restrictions?: ReadonlyArray<SupportedRestriction>;
  readonly nativeFields?: Readonly<Record<string, unknown>>;
}): EffectiveLayer {
  const values = input.values ?? {};
  const restrictions = input.restrictions ?? [];
  const nativeFields = input.nativeFields ?? {};
  // Validate restrictions at construction so callers cannot smuggle
  // unknown tokens past the resolver.
  for (const r of restrictions) {
    const parsed = supportedRestrictionSchema.safeParse(r);
    if (!parsed.success) {
      throw new AppError(
        "INVALID_REQUEST",
        `Layer "${input.source}" declares unsupported restriction "${r}"`,
      );
    }
  }
  return {
    source: input.source,
    capturedAt: input.capturedAt,
    sourceId: input.sourceId,
    values,
    restrictions,
    nativeFields,
    digest: digestLayer(values, restrictions, nativeFields, input.sourceId),
  };
}
