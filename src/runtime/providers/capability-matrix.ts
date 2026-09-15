/**
 * M3b — capability matrix extension.
 *
 * Extends the M3a capability matrix with version-aware native provider
 * detection. The runtime asks the probe for `claude --version` /
 * `codex --version` (via the test seam) and reports
 * `{claude, codex, version, featureCount}` instead of the M3a boolean pair.
 *
 * Unknown / missing binaries degrade visibly: `version: null`,
 * `featureCount: 0`. The probe is read-only (no `npm install`-style
 * mutation) and never caches across calls.
 *
 * M5.3 — additive. The returned matrix also carries
 * `nativeSubagentSupport`: claude advertises a fully-observed
 * subagent path; codex does NOT (M4.1 asymmetry). The runtime's
 * dispatcher (`runtime/orchestration/delegation-policy.ts`) reads
 * this field.
 */
import { spawnSync } from "node:child_process";
import type { CapabilityMatrix } from "../db/capabilities";
import type { NativeSubagentSupport } from "../../shared/delegation-schema";

/** Native matrix extension returned by `extendNativeCapabilities`. */
export interface ExtendedNativeMatrix {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly version: string | null;
  readonly featureCount: number;
  /**
   * M5.3 — additive. Whether the native provider advertises a
   * subagent path the dispatcher can route through.
   * `supported: false` ⇒ the dispatcher forces managed-run
   * (no native-subagent shortcut). */
  readonly nativeSubagentSupport: NativeSubagentSupport;
}

/** Test seam: replace the version probe for the lifetime of a test. */
type VersionProbe = (binary: "claude" | "codex") => string | null;
let versionProbe: VersionProbe = defaultVersionProbe;

/** Default version probe: spawn `<binary> --version` and parse the first line. */
function defaultVersionProbe(binary: "claude" | "codex"): string | null {
  const result = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 1_500,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  const firstLine = (result.stdout ?? "").split("\n", 1)[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : null;
}

export function setVersionProbe(fn: VersionProbe): void { versionProbe = fn; }
export function resetVersionProbe(): void { versionProbe = defaultVersionProbe; }

/**
 * Probe the native provider capabilities on top of `matrix.installed`.
 * Returns `{claude, codex, version, featureCount, nativeSubagentSupport}`.
 * Missing binaries →
 * `{false, version: null, featureCount: 0, nativeSubagentSupport: {supported: false, …}}`.
 */
export function extendNativeCapabilities(matrix: CapabilityMatrix): ExtendedNativeMatrix {
  const claudeAvailable = matrix.installed.node && canFindBinary("claude");
  const codexAvailable = matrix.installed.node && canFindBinary("codex");
  const claudeVersion = claudeAvailable ? versionProbe("claude") : null;
  const codexVersion = codexAvailable ? versionProbe("codex") : null;
  const version = claudeVersion ?? codexVersion;
  const featureCount = (claudeVersion ? 5 : 0) + (codexVersion ? 4 : 0);
  // M5.3 — claude = fully-observed native subagent path; codex
  // does NOT advertise subagent support (M4.1 asymmetry).
  const nativeSubagentSupport: NativeSubagentSupport = claudeVersion
    ? { supported: true, defaultObservation: "fully-observed", capturesPgid: true }
    : { supported: false, defaultObservation: "pid-only", capturesPgid: false };
  return {
    claude: Boolean(claudeVersion),
    codex: Boolean(codexVersion),
    version,
    featureCount,
    nativeSubagentSupport,
  };
}

/** Look for the binary on PATH. Read-only. */
function canFindBinary(name: string): boolean {
  const which = process.env.PATH?.split(":") ?? [];
  for (const dir of which) {
    try {
      const result = spawnSync("test", ["-x", `${dir}/${name}`], { stdio: "ignore" });
      if (result.status === 0) return true;
    } catch {
      // Continue searching.
    }
  }
  return false;
}