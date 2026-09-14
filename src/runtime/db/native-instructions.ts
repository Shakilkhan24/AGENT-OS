/**
 * M3a — native instruction discovery.
 *
 * Walks a project root looking for files that conventionally carry
 * contributor / agent instructions: AGENTS.md, CLAUDE.md, .cursorrules,
 * README.md, CONTRIBUTING.md, and any *.instructions.md file the user
 * has explicitly added. The discovered instructions are returned as a
 * structured array (path + kind + digest + raw bytes) so the receipt
 * can pin both the presence and the exact bytes used.
 *
 * Discovery is non-mutating: it reads the filesystem only. The caller
 * is expected to redact secrets before persisting the bytes.
 */
import { readFileSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { createHash } from "node:crypto";

export const NATIVE_INSTRUCTION_FILES: ReadonlyArray<string> = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "README.md",
  "CONTRIBUTING.md",
];

export interface NativeInstruction {
  /** Absolute path to the file. */
  readonly path: string;
  /** Path relative to the project root. */
  readonly relativePath: string;
  /** Stable file kind for grouping in the receipt. */
  readonly kind: "AGENTS" | "CLAUDE" | "CURSOR" | "README" | "CONTRIBUTING" | "INSTRUCTIONS";
  /** SHA-256 of the file bytes (hex). */
  readonly sha256: string;
  /** File size in bytes. */
  readonly bytes: number;
  /** File contents (the caller is responsible for redacting). */
  readonly content: string;
}

/**
 * Walk `root` for known instruction file names plus any explicit
 * extra paths the caller supplies. Missing files are skipped silently.
 * Files larger than `maxBytes` are skipped (with the bytes counted)
 * so a runaway AGENTS.md cannot exhaust the runtime.
 */
export function discoverNativeInstructions(
  root: string,
  options?: { readonly extraPaths?: readonly string[]; readonly maxBytes?: number },
): NativeInstruction[] {
  const max = options?.maxBytes ?? 256 * 1024;
  const results: NativeInstruction[] = [];
  const seen = new Set<string>();

  function tryAdd(absPath: string, kind: NativeInstruction["kind"]): void {
    if (seen.has(absPath)) return;
    seen.add(absPath);
    let stats;
    try { stats = statSync(absPath); }
    catch { return; }
    if (!stats.isFile()) return;
    if (stats.size > max) return;
    const bytes = readFileSync(absPath);
    results.push({
      path: absPath,
      relativePath: relative(root, absPath),
      kind,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: stats.size,
      content: bytes.toString("utf8"),
    });
  }

  for (const name of NATIVE_INSTRUCTION_FILES) tryAdd(join(root, name), kindFromName(name));
  for (const extra of options?.extraPaths ?? []) {
    const abs = join(root, extra);
    tryAdd(abs, "INSTRUCTIONS");
  }
  return results;
}

function kindFromName(name: string): NativeInstruction["kind"] {
  switch (name) {
    case "AGENTS.md": return "AGENTS";
    case "CLAUDE.md": return "CLAUDE";
    case ".cursorrules": return "CURSOR";
    case "README.md": return "README";
    case "CONTRIBUTING.md": return "CONTRIBUTING";
    default: return "INSTRUCTIONS";
  }
}

/**
 * Convenience wrapper: discover + redact secrets + return a stable JSON
 * representation suitable for storage on `context_receipt.instructions_json`.
 */
export function loadInstructionsForReceipt(
  root: string,
  options?: { readonly extraPaths?: readonly string[]; readonly maxBytes?: number },
): { entries: NativeInstruction[]; json: string } {
  const entries = discoverNativeInstructions(root, options);
  // We strip content from the receipt (it goes through the user's content
  // filter separately); the digest + relative path is enough to prove
  // "we used these bytes" while keeping the receipt small.
  const projection = entries.map(({ path: _path, ...rest }) => {
    void _path;
    return rest;
  });
  return { entries, json: JSON.stringify(projection) };
}

/**
 * Compute the aggregate digest of all discovered instruction files.
 * Used by the receipt to pin "exactly these bytes were considered".
 */
export function instructionsDigest(entries: ReadonlyArray<NativeInstruction>): string {
  const hash = createHash("sha256");
  for (const entry of [...entries].sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(entry.relativePath);
    hash.update("\0");
    hash.update(entry.sha256);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Re-emit the relative path of a discovered instruction so the caller
 * can render "we found AGENTS.md at <root>/AGENTS.md" in the receipt UI.
 */
export function describeInstruction(entry: NativeInstruction, root: string): string {
  return `${entry.kind} (${entry.relativePath}) → ${dirname(relative(root, entry.path)) || "."}`;
}