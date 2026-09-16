/**
 * M5.7 — literal bounded prompt anchors.
 *
 * The M5.7 spec (FUTURE/IMPLEMENTATION-README.md line 235) reads:
 *
 * > M5.7 Add literal bounded prompt anchors as an optional
 * > ordinary-terminal readiness hint, if still useful. A detected
 * > prompt is heuristic and never proof of agent readiness, health
 * > or task completion. Structured providers use their tested event
 *   contract.
 *
 * This module is a *pure* runtime function — no DB, no IPC, no
 * scheduling. The caller (`viewTerminalMemory` in
 * `runtime/db/memory-views.ts`) hands in the bounded lines array
 * already loaded from the ledger; we walk a bounded suffix, look
 * for the latest line whose `content.trimEnd()` ends with any
 * literal in the resolved allowlist, and return a `PromptAnchor`
 * (or `null`).
 *
 * Boundedness is enforced in three places:
 *
 *  - The outer caller clamps `lines` to `MEMORY_VIEW_MAX_TERMINAL_LINES`
 *    (4096) before calling in.
 *  - We slice to `PROMPT_ANCHOR_LINE_WINDOW` (64) so the per-call
 *    scan is bounded tighter than the ledger cap.
 *  - The literal allowlist is capped at 16 entries, each 1..32 chars.
 *
 * The detection rule is **literal `endsWith`**, not regex. The
 * rationale is twofold:
 *
 *  - The bullet says "literal bounded prompt anchors". Regex
 *    semantics drift over time (escape rules, anchoring, capture
 *    groups); literal strings cannot.
 *  - The renderer treats the anchor as a *hint*, not a guarantee.
 *    A simple allowlist of well-known prompt tails (e.g. `$ `,
 *    `❯ `, `╭ `) is easy to reason about and easy to extend
 *    without breaking the digest.
 *
 * Digest convention mirrors M5.5 / M5.6: `stableStringify` over
 * the canonical `{terminalUuid, version, anchoredAt, anchorText,
 * sourceSeq, source}` projection, hashed with SHA-256. The
 * `version: 1` constant is reserved so a future structured-provider
 * anchor (e.g. `permission_request` from a Claude/Codex adapter)
 * can re-use the schema with a different `version` without
 * colliding with today's `literal` digest.
 */
import { createHash } from "node:crypto";
import { stableStringify } from "../db/effective-settings";
import type { PromptAnchor } from "../../shared/prompt-anchor-schema";
import {
  promptAnchorEnabledSchema,
  promptAnchorLiteralsSchema,
  promptAnchorSchema,
  promptAnchorStalenessMsSchema,
  promptAnchorsMaxPerTerminalSchema,
} from "../../shared/prompt-anchor-schema";
import type { TerminalHistoryLine } from "../db/memory-views";

/** Built-in literal allowlist — five well-known prompt tails. */
export const DEFAULT_PROMPT_ANCHOR_LITERALS: readonly string[] = ["$ ", "> ", "❯ ", "╭ ", "› "];

/** Per-call line window. Tighter than `MEMORY_VIEW_MAX_TERMINAL_LINES = 4096`. */
export const PROMPT_ANCHOR_LINE_WINDOW = 64;

/** Bounded per-terminal anchor count. Today only the latest is wired. */
export const DEFAULT_PROMPT_ANCHOR_MAX_PER_TERMINAL = 1;

/** Renderer-side staleness window default. */
export const DEFAULT_PROMPT_ANCHOR_STALENESS_MS = 30_000;

/** Digest version constant. Bumped on the schema variant. */
export const PROMPT_ANCHOR_DIGEST_VERSION = 1;

/** Resolved settings for a single computation. */
export interface PromptAnchorSettings {
  readonly enabled: boolean;
  readonly maxPerTerminal: number;
  readonly stalenessMs: number;
  readonly literals: readonly string[];
}

/** Parse caller-supplied settings, applying the defaults when absent. */
export function resolvePromptAnchorSettings(input: unknown): PromptAnchorSettings {
  const raw = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const enabledRaw = raw.enabled;
  const enabled = enabledRaw === undefined ? true : promptAnchorEnabledSchema.parse(enabledRaw);
  const maxPerTerminalRaw = raw.maxPerTerminal;
  const maxPerTerminal =
    maxPerTerminalRaw === undefined
      ? DEFAULT_PROMPT_ANCHOR_MAX_PER_TERMINAL
      : promptAnchorsMaxPerTerminalSchema.parse(maxPerTerminalRaw);
  const stalenessMsRaw = raw.stalenessMs;
  const stalenessMs =
    stalenessMsRaw === undefined
      ? DEFAULT_PROMPT_ANCHOR_STALENESS_MS
      : promptAnchorStalenessMsSchema.parse(stalenessMsRaw);
  const literalsRaw = raw.literals;
  const customLiterals = literalsRaw === undefined ? [] : promptAnchorLiteralsSchema.parse(literalsRaw);
  const merged = mergeLiteralAllowlist(DEFAULT_PROMPT_ANCHOR_LITERALS, customLiterals);
  return { enabled, maxPerTerminal, stalenessMs, literals: merged };
}

/**
 * Merge the built-in allowlist with a caller-supplied list.
 * Dedup is case-sensitive on the byte sequence; capped at 16 entries
 * (the schema-level cap on `promptAnchorLiteralsSchema`).
 */
export function mergeLiteralAllowlist(
  builtin: readonly string[],
  custom: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const lit of builtin) {
    if (!seen.has(lit)) {
      seen.add(lit);
      out.push(lit);
    }
  }
  for (const lit of custom) {
    if (out.length >= 16) break;
    if (!seen.has(lit)) {
      seen.add(lit);
      out.push(lit);
    }
  }
  return out;
}

/**
 * Compute the SHA-256 `promptAnchorDigest`. Mirrors the
 * `runtime/db/effective-settings.ts:stableStringify` convention so
 * the digest is deterministic across runs.
 */
export function digestPromptAnchor(
  terminalUuid: string,
  anchoredAt: number,
  anchorText: string,
  sourceSeq: number,
  source: PromptAnchor["source"] = "literal",
): string {
  const canonical = {
    terminalUuid,
    version: PROMPT_ANCHOR_DIGEST_VERSION,
    anchoredAt,
    anchorText,
    sourceSeq,
    source,
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/**
 * Walk the bounded lines (in reverse) and return the latest
 * `PromptAnchor`, or `null` when no literal matches or the
 * heuristic is disabled.
 *
 * Boundedness:
 *   - The outer caller clamps `lines` to `MEMORY_VIEW_MAX_TERMINAL_LINES`.
 *   - We slice to `PROMPT_ANCHOR_LINE_WINDOW` before scanning.
 *
 * The matched line's `content.trimEnd()` is the `anchorText`. The
 * matched line's `capturedAt` ISO string is parsed to ms-since-epoch
 * for `anchoredAt`. If parsing fails (malformed row) we fall back
 * to `Date.now()` so the renderer always has a monotonic timestamp.
 */
export function latestPromptAnchor(
  terminalUuid: string,
  lines: ReadonlyArray<TerminalHistoryLine>,
  settings: PromptAnchorSettings,
): PromptAnchor | null {
  if (!settings.enabled) return null;
  if (lines.length === 0) return null;
  if (settings.literals.length === 0) return null;
  const cap = Math.min(lines.length, PROMPT_ANCHOR_LINE_WINDOW);
  const slice = lines.slice(lines.length - cap);
  for (let i = slice.length - 1; i >= 0; i--) {
    const line = slice[i];
    // Match the literal as-is against the raw content. We deliberately
    // do NOT `trimEnd()` first — the literal trailing whitespace is
    // part of the anchor (e.g. `"$ "` is `$` followed by a SPACE, both
    // load-bearing). An empty content line is the only case skipped.
    if (line.content.length === 0) continue;
    let matched: string | null = null;
    for (const lit of settings.literals) {
      if (line.content.endsWith(lit)) {
        matched = lit;
        break;
      }
    }
    if (matched === null) continue;
    const parsedMs = Date.parse(line.capturedAt);
    const anchoredAt = Number.isFinite(parsedMs) && parsedMs >= 0 ? parsedMs : Date.now();
    const anchorText = line.content;
    const promptAnchorDigest = digestPromptAnchor(terminalUuid, anchoredAt, anchorText, line.seq);
    return promptAnchorSchema.parse({
      terminalUuid,
      anchoredAt,
      anchorText,
      sourceSeq: line.seq,
      source: "literal",
      promptAnchorDigest,
    });
  }
  return null;
}
