/**
 * Single-source version export.
 *
 * Resolution order:
 *   1. `__MINIMAL_VERSION__` injected at bundle time by `scripts/build.mjs`
 *      via esbuild's `define` (used for the packaged runtime).
 *   2. The bundled `package.json` adjacent to the running binary.
 *   3. The source-tree `../../package.json` (used by `tsx`-driven tests).
 *   4. The literal fallback `VERSION_FALLBACK` below.
 *
 * The fallback is set to `"0.0.0-unknown"` so a missed injection is
 * obvious in any log line; tests that need a deterministic value should
 * read `process.env.MINIMAL_VERSION_OVERRIDE` (the test seam) or
 * call `resolveVersion` directly.
 */
import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Hard fallback when no other source resolves. */
export const VERSION_FALLBACK = "0.0.0-unknown";

interface MaybeGlobal {
  __MINIMAL_VERSION__?: string;
}

const injected = (globalThis as MaybeGlobal).__MINIMAL_VERSION__;

/** Test seam: force the version to a deterministic value. */
let override: string | undefined = (() => {
  const fromEnv = typeof process !== "undefined" && process.env
    ? process.env.MINIMAL_VERSION_OVERRIDE
    : undefined;
  return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : undefined;
})();

/** Set the version explicitly (tests only). */
export function setVersionForTest(value: string | undefined): void {
  override = value;
}

/** Resolve the package.json path relative to the running module. */
function findPackageJson(): string | undefined {
  const candidates: string[] = [];
  if (typeof __dirname === "string") {
    candidates.push(path.resolve(__dirname, "..", "..", "package.json"));
    candidates.push(path.resolve(__dirname, "..", "package.json"));
    candidates.push(path.resolve(__dirname, "package.json"));
  }
  // ESM path
  try {
    const here = fileURLToPath(import.meta.url);
    candidates.push(path.resolve(path.dirname(here), "..", "..", "package.json"));
    candidates.push(path.resolve(path.dirname(here), "..", "package.json"));
  } catch {
    /* not ESM */
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function readPackageJsonVersion(): string | undefined {
  const file = findPackageJson();
  if (!file) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the current version following the documented order.
 * Exported separately from `VERSION` so tests can re-resolve after
 * `setVersionForTest` without module-cache interference.
 */
export function resolveVersion(): string {
  if (typeof override === "string") return override;
  if (typeof injected === "string" && injected.length > 0) return injected;
  const fromPkg = readPackageJsonVersion();
  if (typeof fromPkg === "string" && fromPkg.length > 0) return fromPkg;
  return VERSION_FALLBACK;
}

/**
 * The version constant. Computed at module load via `resolveVersion()`.
 * For tests, use `setVersionForTest` + `resolveVersion()` directly.
 */
export const VERSION: string = resolveVersion();
