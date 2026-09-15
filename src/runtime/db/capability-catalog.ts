/**
 * M4.3 — Curated local capability catalog.
 *
 * A capability is a discrete resource a managed task may invoke or
 * reference. The roadmap lists nine distinct kinds: skills, native
 * plugins, MCP servers, commands, scripts, hooks, context sources,
 * environment templates and recipes. Each kind has its own origin,
 * data shape, and scope; the catalog is the read-only inventory
 * surface that surfaces them in a unified list.
 *
 * `scanCapabilityCatalog` is the only mutation-free scan entry point
 * in this increment. It returns a `Capability[]` whose digests are
 * stable across rescans of the same underlying state — the digest
 * is SHA-256 over a canonical JSON of `(kind, displayName, origin,
 * data, scope)`. The scan never installs, fetches, or mutates
 * anything: "no installation occurs merely because a task mentions
 * a tool" (M4.3 roadmap).
 *
 * The scanner bridges four existing surfaces into the catalog:
 *  - `preset` rows → `command` capabilities
 *  - `env_profile` rows → `environment-template` capabilities
 *  - `hook` rows → `hook` capabilities
 *  - the M3a native-instructions walker → `context-source`
 *    capabilities
 *
 * The remaining kinds (skill, native-plugin, mcp-server, script,
 * recipe) are populated by caller-supplied `CapabilitySource`
 * directories so a future M4.4 installer can register resources
 * without forcing this increment to ship new filesystem conventions.
 *
 * The M4.3 increment is read-only. No IPC method, no installer
 * plane, no activation state — the M4.4 increment owns those.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import {
  discoverNativeInstructions,
  type NativeInstruction,
} from "./native-instructions";

/**
 * The nine capability kinds. Adding a new kind is a deliberate
 * decision — each kind promises a distinct origin, data shape and
 * scope that the renderer + M4.4 installer understand. Unknown
 * kinds raise `INVALID_REQUEST` at scan time so a typo cannot
 * silently be classified.
 */
export const CAPABILITY_KINDS = [
  "skill",
  "native-plugin",
  "mcp-server",
  "command",
  "script",
  "hook",
  "context-source",
  "environment-template",
  "recipe",
] as const;
export const capabilityKindSchema = z.enum(CAPABILITY_KINDS);
export type CapabilityKind = z.infer<typeof capabilityKindSchema>;

/**
 * Where the capability was discovered. The shape `(table-name)` is
 * reserved for existing resource tables; `(filesystem:<abs-path>)`
 * for caller-supplied manifest directories; `(capability-probe:
 * <provider>)` for binaries reported by M3b's capability probe;
 * `(instructions-walker:<root>)` for `AGENTS.md` /
 * `CLAUDE.md`-style context files.
 */
export const capabilityOriginSchema = z.string().min(1).max(512);
export type CapabilityOrigin = z.infer<typeof capabilityOriginSchema>;

/**
 * Three distinct scopes. The renderer and M4.4 installer use this
 * to render an "active / inactive / read-only" indicator without
 * consulting out-of-band metadata.
 *
 *  - `ReadOnly` — discovered, cannot be invoked or mutated by the
 *    user from the catalog surface (e.g. an existing `hook` row
 *    is read-only until M4.7's hook-execution seam lands).
 *  - `UserWritable` — discovered, can be edited by the user.
 *  - `RuntimeActivation` — discovered, can be activated by the
 *    runtime (e.g. an environment profile the runtime can
 *    choose to inherit).
 */
export const capabilityScopeSchema = z.enum([
  "ReadOnly",
  "UserWritable",
  "RuntimeActivation",
]);
export type CapabilityScope = z.infer<typeof capabilityScopeSchema>;

/**
 * Kind-specific payload. This is `unknown` at the schema level; the
 * `kind` discriminant selects the runtime validator. A malformed
 * payload raises `AppError("CONFLICT", …)` so the renderer can show
 * a "skipped on scan" indicator rather than dropping the row.
 */
export type CapabilityData = Readonly<Record<string, unknown>>;

export const capabilitySchema = z
  .object({
    capabilityId: z.string().uuid(),
    kind: capabilityKindSchema,
    displayName: z.string().trim().min(1).max(200),
    origin: capabilityOriginSchema,
    scope: capabilityScopeSchema,
    data: z.record(z.string(), z.unknown()),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    inventoryAt: z.string().datetime(),
  })
  .strict();
export type Capability = z.infer<typeof capabilitySchema>;

/**
 * Caller-supplied sources for kinds this increment does not yet
 * inventory from a built-in surface. Each source is a directory
 * whose JSON files follow `CapabilitySourceManifest`. The scanner
 * **only reads** these directories — it never invokes the
 * referenced binaries, never executes the scripts, never contacts
 * the MCP endpoints.
 */
export interface CapabilitySource {
  readonly kind: CapabilityKind;
  readonly root: string;
}

export interface CapabilitySourceManifest {
  readonly displayName: string;
  readonly data: CapabilityData;
  readonly scope?: CapabilityScope;
}

export const capabilitySourceManifestSchema = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()).default({}),
    scope: capabilityScopeSchema.optional(),
  })
  .strict();
export type ParsedCapabilitySourceManifest = z.infer<typeof capabilitySourceManifestSchema>;

/**
 * Per-kind inventory for the catalog result. Each map is keyed by
 * the resource's stable identity so the renderer can render keyed
 * lists without scanning the array.
 */
export interface CapabilityCatalogInventory {
  readonly byKind: Readonly<Record<CapabilityKind, ReadonlyArray<Capability>>>;
  readonly total: number;
  readonly inventoryAt: string;
  readonly unknownKinds: ReadonlyArray<string>;
  readonly skippedSources: ReadonlyArray<{ source: CapabilitySource; reason: string }>;
}

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/**
 * Deterministic JSON serialisation. Keys are sorted at every level;
 * arrays are kept in the order the source supplied them (the
 * scanner always emits them in deterministic order so digest
 * stability does not require array sorting).
 */
export function canonicalCapabilityStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalCapabilityStringify(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalCapabilityStringify(obj[k])}`).join(",")}}`;
}

/**
 * Compute the canonical digest for a Capability row. The digest is
 * stable across rescans of the same underlying state because the
 * scanner always emits the inputs in a fixed order.
 */
export function digestCapability(input: {
  kind: CapabilityKind;
  displayName: string;
  origin: CapabilityOrigin;
  data: CapabilityData;
  scope: CapabilityScope;
}): string {
  return createHash("sha256")
    .update(canonicalCapabilityStringify(input), "utf8")
    .digest("hex");
}

/**
 * Build a single Capability record. Computes the digest and
 * generates a UUID v4 `capabilityId` from the digest so rescan
 * stability survives identity regeneration.
 */
export function buildCapability(input: {
  kind: CapabilityKind;
  displayName: string;
  origin: CapabilityOrigin;
  data: CapabilityData;
  scope: CapabilityScope;
  inventoryAt: string;
}): Capability {
  const digest = digestCapability(input);
  return capabilitySchema.parse({
    capabilityId: deterministicUuidFromDigest(digest),
    kind: input.kind,
    displayName: input.displayName,
    origin: input.origin,
    scope: input.scope,
    data: input.data,
    digest,
    inventoryAt: input.inventoryAt,
  });
}

/**
 * Convert a SHA-256 digest into a stable UUID v4. Not cryptographically
 * random — but stable across rescans, which is the property the catalog
 * needs.
 */
function deterministicUuidFromDigest(digest: string): string {
  // The first 32 hex digits (16 bytes) become the UUID body; flip the
  // version/variant bits so the string parses as a v4 UUID.
  const body = digest.replace(/[^0-9a-f]/gi, "").slice(0, 32).padEnd(32, "0");
  const a = body.slice(0, 8);
  const b = body.slice(8, 12);
  const c = "4" + body.slice(13, 16);
  const d = ((parseInt(body.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + body.slice(17, 20);
  const e = body.slice(20, 32);
  return `${a}-${b}-${c}-${d}-${e}`;
}

/**
 * Scan options. `capabilitySources` are caller-supplied directories
 * for kinds the catalog does not yet auto-inventory (skill, native-
 * plugin, mcp-server, script, recipe); `instructionsRoots` are
 * roots the native-instructions walker scans for context sources.
 */
export interface ScanCapabilityCatalogInput {
  readonly capabilitySources?: ReadonlyArray<CapabilitySource>;
  readonly instructionsRoots?: ReadonlyArray<string>;
}

/**
 * Read-only capability catalog scan. The function returns a
 * `CapabilityCatalogInventory` whose `byKind` map covers every kind
 * the roadmap lists. Unknown kinds raise at scan-input validation;
 * malformed rows in the existing tables (`preset`, `env_profile`,
 * `hook`) are skipped with a `skippedSources` entry, never silently
 * dropped.
 */
export async function scanCapabilityCatalog(
  worker: DbWorker,
  input: ScanCapabilityCatalogInput = {},
): Promise<CapabilityCatalogInventory> {
  const inventoryAt = new Date().toISOString();
  const byKind: Record<CapabilityKind, Capability[]> = {
    skill: [],
    "native-plugin": [],
    "mcp-server": [],
    command: [],
    script: [],
    hook: [],
    "context-source": [],
    "environment-template": [],
    recipe: [],
  };
  const skippedSources: { source: CapabilitySource; reason: string }[] = [];
  const unknownKinds = new Set<string>();

  // 1. Existing resource tables → commands, environment-templates, hooks.
  const driver = driverOf(worker);
  for (const row of driver.prepare(`SELECT uuid, name, command FROM preset`).all()) {
    const display = String(row.name ?? "").trim();
    const command = String(row.command ?? "");
    if (!display || !command) {
      skippedSources.push({
        source: { kind: "command", root: "preset-table" },
        reason: `preset row "${row.uuid}" has empty name or command`,
      });
      continue;
    }
    byKind.command.push(buildCapability({
      kind: "command",
      displayName: display,
      origin: `preset-table:${String(row.uuid ?? "")}`,
      scope: "RuntimeActivation",
      data: { command },
      inventoryAt,
    }));
  }

  for (const row of driver.prepare(`SELECT uuid, name, variables_json FROM env_profile`).all()) {
    const display = String(row.name ?? "").trim();
    if (!display) {
      skippedSources.push({
        source: { kind: "environment-template", root: "env-profile-table" },
        reason: `env_profile row "${row.uuid}" has empty name`,
      });
      continue;
    }
    let variables: unknown = {};
    try {
      variables = JSON.parse(String(row.variables_json ?? "{}"));
    } catch (error) {
      skippedSources.push({
        source: { kind: "environment-template", root: "env-profile-table" },
        reason: `env_profile row "${row.uuid}" has invalid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
      continue;
    }
    if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
      skippedSources.push({
        source: { kind: "environment-template", root: "env-profile-table" },
        reason: `env_profile row "${row.uuid}" variables must be a JSON object`,
      });
      continue;
    }
    byKind["environment-template"].push(buildCapability({
      kind: "environment-template",
      displayName: display,
      origin: `env-profile-table:${String(row.uuid ?? "")}`,
      scope: "RuntimeActivation",
      data: { variables },
      inventoryAt,
    }));
  }

  for (const row of driver.prepare(`SELECT uuid, name, event, session_uuid, terminal_uuid, match FROM hook`).all()) {
    const display = String(row.name ?? "").trim();
    if (!display) {
      skippedSources.push({
        source: { kind: "hook", root: "hook-table" },
        reason: `hook row "${row.uuid}" has empty name`,
      });
      continue;
    }
    byKind.hook.push(buildCapability({
      kind: "hook",
      displayName: display,
      origin: `hook-table:${String(row.uuid ?? "")}`,
      scope: "ReadOnly",
      data: {
        event: String(row.event ?? ""),
        sessionUuid: row.session_uuid ? String(row.session_uuid) : null,
        terminalUuid: row.terminal_uuid ? String(row.terminal_uuid) : null,
        match: row.match ? String(row.match) : null,
      },
      inventoryAt,
    }));
  }

  // 2. Native-instructions walker → context-source capabilities. We
  // delegate to the existing M3a walker so the catalog never diverges
  // from what a context-receipt would assemble.
  if (input.instructionsRoots && input.instructionsRoots.length > 0) {
    for (const root of input.instructionsRoots) {
      try {
        const found: NativeInstruction[] = discoverNativeInstructions(root);
        for (const instruction of found) {
          byKind["context-source"].push(buildCapability({
            kind: "context-source",
            displayName: instruction.path,
            origin: `instructions-walker:${root}`,
            scope: "ReadOnly",
            data: {
              path: instruction.path,
              kind: instruction.kind,
              bytes: instruction.bytes,
              sha256: instruction.sha256,
            },
            inventoryAt,
          }));
        }
      } catch (error) {
        skippedSources.push({
          source: { kind: "context-source", root },
          reason: `instructions walker failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  // 3. Caller-supplied directories for kinds this increment does not
  // auto-inventory. The scanner **only reads** — it never invokes,
  // installs or contacts anything.
  if (input.capabilitySources) {
    for (const source of input.capabilitySources) {
      const valid = capabilityKindSchema.safeParse(source.kind);
      if (!valid.success) {
        unknownKinds.add(source.kind);
        continue;
      }
      try {
        const fs = await import("node:fs/promises");
        const entries = await fs.readdir(source.root, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
          const file = `${source.root}/${entry.name}`;
          let raw: string;
          try {
            raw = await fs.readFile(file, "utf8");
          } catch (error) {
            skippedSources.push({
              source,
              reason: `${entry.name} read failed: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
          let json: unknown;
          try {
            json = JSON.parse(raw);
          } catch (error) {
            skippedSources.push({
              source,
              reason: `${entry.name} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
            });
            continue;
          }
          const parsed = capabilitySourceManifestSchema.safeParse(json);
          if (!parsed.success) {
            skippedSources.push({
              source,
              reason: `${entry.name} failed manifest parse: ${parsed.error.message}`,
            });
            continue;
          }
          byKind[source.kind].push(buildCapability({
            kind: source.kind,
            displayName: parsed.data.displayName,
            origin: `filesystem:${file}`,
            scope: parsed.data.scope ?? "UserWritable",
            data: parsed.data.data,
            inventoryAt,
          }));
        }
      } catch (error) {
        skippedSources.push({
          source,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Validate the final shape so a malformed buildCapability call can
  // never silently slip past the scanner.
  const validated: Record<CapabilityKind, ReadonlyArray<Capability>> = {
    skill: byKind.skill.map((c) => capabilitySchema.parse(c)),
    "native-plugin": byKind["native-plugin"].map((c) => capabilitySchema.parse(c)),
    "mcp-server": byKind["mcp-server"].map((c) => capabilitySchema.parse(c)),
    command: byKind.command.map((c) => capabilitySchema.parse(c)),
    script: byKind.script.map((c) => capabilitySchema.parse(c)),
    hook: byKind.hook.map((c) => capabilitySchema.parse(c)),
    "context-source": byKind["context-source"].map((c) => capabilitySchema.parse(c)),
    "environment-template": byKind["environment-template"].map((c) => capabilitySchema.parse(c)),
    recipe: byKind.recipe.map((c) => capabilitySchema.parse(c)),
  };

  let total = 0;
  for (const list of Object.values(validated)) total += list.length;

  return {
    byKind: validated,
    total,
    inventoryAt,
    unknownKinds: [...unknownKinds],
    skippedSources,
  };
}

/**
 * Convenience: flatten a `CapabilityCatalogInventory` into a single
 * `Capability[]` (e.g. for a renderer that prefers list rendering
 * over grouped rendering). Order is the same as `byKind`'s key
 * order, which is the canonical `CAPABILITY_KINDS` order.
 */
export function flattenCapabilityCatalog(
  inventory: CapabilityCatalogInventory,
): Capability[] {
  const out: Capability[] = [];
  for (const kind of CAPABILITY_KINDS) {
    for (const capability of inventory.byKind[kind]) {
      out.push(capability);
    }
  }
  return out;
}

/**
 * Validate a single `CapabilitySource.kind` is one of the nine
 * recognised kinds. Exported so the M4.4 installer plane can reuse
 * the gate when it registers a new resource directory.
 */
export function assertCapabilityKind(kind: string): CapabilityKind {
  const parsed = capabilityKindSchema.safeParse(kind);
  if (!parsed.success) {
    throw new AppError(
      "INVALID_REQUEST",
      `Unknown capability kind "${kind}" (allowed: ${CAPABILITY_KINDS.join(", ")})`,
    );
  }
  return parsed.data;
}

/**
 * Test seam: generate a fresh `capabilityId` independently of the
 * digest. Production callers should never use this — the catalog
 * always derives the id from the digest for stability.
 */
export function freshCapabilityId(): string {
  return randomUUID();
}
