/**
 * M3a — Non-mutating capability / configuration preflight.
 *
 * `probeCapabilities` returns the typed capability matrix used by the rest
 * of M3a to decide what a provider/restriction can do. The probe is
 * **read-only**: it never mutates the database or filesystem beyond what
 * `which` / `stat` are already doing. Repeated calls re-read the filesystem
 * state — there's no cross-call cache.
 *
 * Test override: `setCapabilityProbe(fn)` swaps the probe for the lifetime
 * of the test. Production callers never invoke the override directly; the
 * test serialisation is honoured because the override is process-global.
 * The override is reset by `resetCapabilityProbe()`.
 *
 * Trusted-host mode: `supportedRestrictions` lists what the current host
 * can enforce; any restriction outside that list is `unsupported`. The
 * grant service rejects requests that include an unsupported restriction.
 */
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { extendNativeCapabilities } from "../providers/capability-matrix";
import { nativeSubagentSupportSchema } from "../../shared/delegation-schema";

/** Discriminated capability set returned by the probe. */
export const capabilityMatrixSchema = z.object({
  /** Process-side binaries the runtime can spawn. */
  installed: z.object({
    git: z.boolean(),
    tmux: z.boolean(),
    python3: z.boolean(),
    node: z.boolean(),
  }).strict(),
  /** Native provider capabilities — version-aware as of M3b. */
  native: z.union([
    // Legacy shape (M3a): keep accepting `{claude, codex}` for back-compat
    // with existing test overrides. The M5.3 `nativeSubagentSupport`
    // field is OPTIONAL on the legacy shape so existing test
    // overrides keep passing without modification.
    z.object({
      claude: z.boolean(),
      codex: z.boolean(),
      nativeSubagentSupport: nativeSubagentSupportSchema.optional(),
    }).strict(),
    // Current shape: version-aware. The M5.3 `nativeSubagentSupport`
    // field carries the dispatcher's per-provider input. It is
    // optional so test stubs that pre-date M5.3 keep passing;
    // absent ⇒ `{supported: false, defaultObservation: "pid-only",
    // capturesPgid: false}` per the M4.1 asymmetry note (the
    // safe default is "no native subagent support").
    z.object({
      claude: z.boolean(),
      codex: z.boolean(),
      version: z.string().nullable(),
      featureCount: z.number().int().min(0),
      nativeSubagentSupport: nativeSubagentSupportSchema.optional(),
    }).strict(),
  ]),
  /** Restrictions the current host can enforce (process-wide). */
  supportedRestrictions: z.array(z.string().min(1).max(64)),
  /** Restrictions the host cannot enforce. */
  unsupportedRestrictions: z.array(z.string().min(1).max(64)),
  /** ISO timestamp the probe ran at (so callers can audit stale reads). */
  probedAt: z.string().datetime(),
  /** Identifies the host for downstream audit + retry logic. */
  hostTag: z.enum(["trusted", "untrusted", "unknown"]),
}).strict();
export type CapabilityMatrix = z.infer<typeof capabilityMatrixSchema>;

/** Same shape, default for the common case. */
const DEFAULT_MATRIX = (hostTag: "trusted" | "untrusted" | "unknown"): CapabilityMatrix => {
  const installed = probeInstalled();
  return {
    installed,
    native: extendNativeCapabilities({
      installed, native: { claude: false, codex: false },
      supportedRestrictions: [], unsupportedRestrictions: [],
      probedAt: new Date(0).toISOString(), hostTag,
    }),
    supportedRestrictions: hostTag === "trusted"
      ? ["no-network", "no-shell-exec", "read-only-filesystem"]
      : ["read-only-filesystem"],
    unsupportedRestrictions: hostTag === "trusted"
      ? ["no-network", "no-shell-exec", "read-only-filesystem"]
      : ["no-network", "no-shell-exec"],
    probedAt: new Date().toISOString(),
    hostTag,
  };
};

function probeInstalled(): CapabilityMatrix["installed"] {
  // Look for binaries on PATH; this is a quick existence check, not a version
  // probe. A more rigorous version probe is M3b's job; M3a only needs to know
  // whether the binary can be spawned.
  const which = (bin: string): boolean => {
    const candidates = process.env.PATH?.split(path.delimiter) ?? [];
    for (const dir of candidates) {
      try {
        statSync(path.join(dir, bin));
        return true;
      } catch {
        // Continue searching.
      }
    }
    return false;
  };
  return {
    git: which("git"),
    tmux: which("tmux"),
    python3: which("python3"),
    node: true,
  };
}

type ProbeOverride = (hostTag: "trusted" | "untrusted" | "unknown") => CapabilityMatrix | Promise<CapabilityMatrix>;
let override: ProbeOverride | undefined;

/** Test seam: replace the probe for the lifetime of the test. */
export function setCapabilityProbe(fn: ProbeOverride): void { override = fn; }
/** Test seam: clear any installed override. */
export function resetCapabilityProbe(): void { override = undefined; }

/**
 * Probe the host's capabilities. Always re-reads filesystem state; never
 * caches across calls. The hostTag is derived from `MINIMAL_HOST_TAG` env
 * var (default "untrusted") and is part of the returned matrix.
 */
export async function probeCapabilities(): Promise<CapabilityMatrix> {
  const tag = parseHostTag(process.env.MINIMAL_HOST_TAG);
  if (override) {
    const matrix = await override(tag);
    // The probe's content is arbitrary (it's a test seam); validate the
    // shape so a typo'd test can't silently ship wrong data.
    return capabilityMatrixSchema.parse(matrix);
  }
  return DEFAULT_MATRIX(tag);
}

function parseHostTag(raw: string | undefined): "trusted" | "untrusted" | "unknown" {
  if (raw === "trusted" || raw === "untrusted") return raw;
  return "unknown";
}

/** Read-only helper: can a binary be stat'd? Used by tests. */
export function binaryExists(file: string): boolean {
  try {
    statSync(file);
    return true;
  } catch {
    return false;
  }
}

/** Read-only helper: can the current uid read a path? */
export function canRead(file: string): boolean {
  try { accessSync(file, fsConstants.R_OK); return true; }
  catch { return false; }
}