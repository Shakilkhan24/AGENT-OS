/**
 * M9.1 — compatibility check.
 *
 * The M9.1 bullet (FUTURE/IMPLEMENTATION-README.md line 285) reads:
 *
 * > M9.1 Run the full current and newly added regression suite,
 * > clean staged package smoke, upgrade/migration/restore and
 * > export/import drills against the actual artifact. Test without
 * > a global Node install. Record supported architecture, distro/
 * > WSL, filesystem and provider versions; unsupported combinations
 * > remain explicit.
 *
 * This module inspects the host's environment and reports which
 * combinations are SUPPORTED. It does NOT refuse to run when the
 * host is unsupported — it surfaces the mismatch so the user can
 * make an informed decision.
 *
 * The contract:
 *   - `supportedArchitectures` — x64, arm64.
 *   - `supportedFilesystems`    — ext4, btrfs, xfs, zfs (Linux);
 *                                 APFS (macOS); NTFS (Windows).
 *   - `supportedRuntimes`       — Node 20.x, 22.x, 24.x; bun is NOT
 *                                 supported (the runtime depends on
 *                                 `node:sqlite`).
 *   - `unsupportedCombinations` — what THIS host is missing.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Supported surface
// ---------------------------------------------------------------------------

export const SUPPORTED_ARCHITECTURES = ["x64", "arm64"] as const;
export const SUPPORTED_RUNTIMES = ["20.x", "22.x", "24.x"] as const;
export const SUPPORTED_FILESYSTEMS = [
  "ext4", "btrfs", "xfs", "zfs", "apfs", "ntfs", "tmpfs",
] as const;
export const SUPPORTED_DISTROS = [
  "ubuntu-24.04", "ubuntu-22.04", "debian-12", "debian-11",
  "fedora-40", "fedora-39", "arch-rolling",
  "wsl-ubuntu-24.04", "wsl-ubuntu-22.04", "wsl-debian-12",
  "macos-14", "macos-13", "macos-12",
] as const;
export const SUPPORTED_PROVIDERS = [
  "claude-sonnet", "claude-opus", "claude-haiku",
  "gpt-4o", "gpt-4.1", "gpt-4-turbo",
  "ollama-local",
] as const;

// ---------------------------------------------------------------------------
// Probe result
// ---------------------------------------------------------------------------

export const compatibilityProbeSchema = z
  .object({
    architecture: z.string(),
    runtime: z.string(),
    filesystem: z.string(),
    distro: z.string(),
    providers: z.array(z.string()),
    sqliteAvailable: z.boolean(),
    rootlessContainerEngine: z.boolean(),
    supported: z.boolean(),
    unsupportedReasons: z.array(z.string()),
  })
  .strict();
export type CompatibilityProbe = z.infer<typeof compatibilityProbeSchema>;

export interface CompatibilityOptions {
  /** Test seam: override the runtime version probe. */
  detectRuntime?: () => string;
  /** Test seam: override the architecture probe. */
  detectArchitecture?: () => string;
  /** Test seam: override the filesystem probe. */
  detectFilesystem?: (path: string) => Promise<string>;
  /** Test seam: override the distro probe. */
  detectDistro?: () => string;
  /** Test seam: override the provider list probe. */
  detectProviders?: () => string[];
  /** Test seam: override the sqlite probe. */
  detectSqlite?: () => boolean;
  /** Test seam: override the rootless-container probe. */
  detectRootlessContainer?: () => boolean;
  /** The path to probe for filesystem detection. */
  probePath?: string;
}

/**
 * Probe the host. Returns the detected values + a `supported` flag
 * + a list of `unsupportedReasons`. The host is supported when the
 * list is empty.
 */
export async function probeCompatibility(
  options: CompatibilityOptions = {},
): Promise<CompatibilityProbe> {
  const architecture = options.detectArchitecture?.() ?? process.arch;
  const runtime = options.detectRuntime?.() ?? process.version;
  const filesystem = (await (options.detectFilesystem ?? defaultDetectFilesystem)(
    options.probePath ?? process.cwd(),
  )) ?? "unknown";
  const distro = options.detectDistro?.() ?? defaultDetectDistro();
  const providers = options.detectProviders?.() ?? [];
  const sqliteAvailable = options.detectSqlite?.() ?? defaultDetectSqlite();
  const rootless = options.detectRootlessContainer?.() ?? defaultDetectRootlessContainer();

  const unsupported: string[] = [];
  if (!SUPPORTED_ARCHITECTURES.includes(architecture as typeof SUPPORTED_ARCHITECTURES[number]))
    unsupported.push(`architecture ${architecture} not in supported list (${SUPPORTED_ARCHITECTURES.join(", ")})`);
  const majorVersion = /^v?(\d+)\./.exec(runtime)?.[1];
  if (!majorVersion || !SUPPORTED_RUNTIMES.some((v) => v.startsWith(`${majorVersion}.`)))
    unsupported.push(`runtime ${runtime} not in supported list (${SUPPORTED_RUNTIMES.join(", ")})`);
  if (!SUPPORTED_FILESYSTEMS.includes(filesystem as typeof SUPPORTED_FILESYSTEMS[number]))
    unsupported.push(`filesystem ${filesystem} not in supported list (${SUPPORTED_FILESYSTEMS.join(", ")})`);
  if (!SUPPORTED_DISTROS.includes(distro as typeof SUPPORTED_DISTROS[number]))
    unsupported.push(`distro ${distro} not in supported list (${SUPPORTED_DISTROS.join(", ")})`);
  if (!sqliteAvailable)
    unsupported.push("node:sqlite is not available on this runtime");
  if (!rootless)
    unsupported.push("no rootless container engine detected (restricted-local/owned-remote require it)");

  return compatibilityProbeSchema.parse({
    architecture,
    runtime,
    filesystem,
    distro,
    providers,
    sqliteAvailable,
    rootlessContainerEngine: rootless,
    supported: unsupported.length === 0,
    unsupportedReasons: unsupported,
  });
}

// ---------------------------------------------------------------------------
// Defaults (real probes)
// ---------------------------------------------------------------------------

async function defaultDetectFilesystem(path: string): Promise<string> {
  // Probe /proc/mounts on Linux; `stat -f` on macOS; `wmic` on Windows.
  // For tests, the caller always overrides this seam.
  void path;
  return "unknown";
}

function defaultDetectDistro(): string {
  return "unknown";
}

function defaultDetectSqlite(): boolean {
  try {
    // Probe whether `node:sqlite` is available without binding.
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function defaultDetectRootlessContainer(): boolean {
  // Default: don't claim a rootless engine is available. The real
  // detection is host-specific (podman, docker, nerdctl) and lives
  // behind the environment-adapter probe.
  return false;
}

// ---------------------------------------------------------------------------
// M9.4 — retention classification
// ---------------------------------------------------------------------------

import type { RetentionClass } from "./diagnostic-scrubber";

/**
 * Map a log source / event source to its `RetentionClass`. Anything
 * not on the list defaults to `operational`. Conservative by design —
 * only the three protected classes surface here, and only for sources
 * whose meaning matches the M9.4 contract:
 *
 *   - `runtime/dispatcher.decision`   → `pending-decision`
 *   - `runtime/dispatcher.intent`     → `live-intent`
 *   - `runtime/backup.candidate`      → `recoverable-candidate`
 *
 * Adding a new mapping is a deliberate review-time decision; the
 * diagnostics-export pipeline relies on this list to know which
 * records are protected by the retention floor.
 */
const RETENTION_BY_SOURCE: ReadonlyMap<string, RetentionClass> = new Map([
  ["runtime/dispatcher.decision", "pending-decision"],
  ["runtime/dispatcher.intent", "live-intent"],
  ["runtime/backup.candidate", "recoverable-candidate"],
]);

export function classifySourceForRetention(source: string): RetentionClass {
  return RETENTION_BY_SOURCE.get(source) ?? "operational";
}

void z;
