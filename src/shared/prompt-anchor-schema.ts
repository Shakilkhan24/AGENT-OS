/**
 * M5.7 — literal bounded prompt-anchor schemas.
 *
 * The M5.7 spec (FUTURE/IMPLEMENTATION-README.md line 235) reads:
 *
 * > M5.7 Add literal bounded prompt anchors as an optional
 * > ordinary-terminal readiness hint, if still useful. A detected
 * > prompt is heuristic and never proof of agent readiness, health
 * > or task completion. Structured providers use their tested event
 * > contract.
 *
 * The trust model:
 *
 *  - A `PromptAnchor` is a *hint*, not a guarantee. It carries an
 *    `anchoredAt` timestamp + a content-addressed `promptAnchorDigest`
 *    so the renderer can detect staleness and recompute deterministically.
 *  - `source` is the discriminator. Only `"literal"` is wired today
 *    (the detection rule is a literal `endsWith` match against a
 *    bounded allowlist). Structured providers (claude/codex) are
 *    expected to extend this enum when their tested event contract
 *    ships an `idle` / `permission_request` event.
 *  - The anchor is bounded by *per-terminal count* (one anchor per
 *    terminal — latest match wins) and *per-line window* (the
 *    runtime walks only the last `PROMPT_ANCHOR_LINE_WINDOW = 64`
 *    lines of the bounded `data.lines`).
 *  - Settings keys extend the `SETTING_KEYS` allowlist in
 *    `runtime/db/effective-settings.ts`. Each literal is 1..32 chars,
 *    the array is capped at 16 entries, and the merged allowlist is
 *    deduplicated at resolve time.
 *
 * Renderer / IPC integration is deferred to M5.7-follow-up. The
 * runtime ships `PromptAnchor | null` on `TerminalMemoryData` so
 * any future caller sees the hint in the same envelope.
 */
import { z } from "zod";

/** Detection rule discriminator. Today only `literal` is wired. */
export const promptAnchorSourceSchema = z.enum(["literal"]);
export type PromptAnchorSource = z.infer<typeof promptAnchorSourceSchema>;

/**
 * The anchor payload. `anchoredAt` is the millisecond timestamp
 * derived from the matched line's `capturedAt` field; `promptAnchorDigest`
 * is the 64-hex SHA-256 over the canonical
 * `{terminalUuid, version, anchoredAt, anchorText, sourceSeq, source}`
 * projection (mirrors the M5.5 / M5.6 digest pattern).
 */
export const promptAnchorSchema = z
  .object({
    terminalUuid: z.string().uuid(),
    anchoredAt: z.number().int().nonnegative(),
    anchorText: z.string().min(1).max(4096),
    sourceSeq: z.number().int().nonnegative(),
    source: promptAnchorSourceSchema,
    promptAnchorDigest: z.string().length(64),
  })
  .strict();
export type PromptAnchor = z.infer<typeof promptAnchorSchema>;

/**
 * The result envelope returned by the runtime computation.
 * `kind: "terminal"` mirrors the discriminator already used by
 * `viewTerminalMemory` / `viewSessionMemory` / `viewTaskMemory`.
 */
export const promptAnchorResultSchema = z
  .object({
    kind: z.literal("terminal"),
    promptAnchor: promptAnchorSchema.nullable(),
  })
  .strict();
export type PromptAnchorResult = z.infer<typeof promptAnchorResultSchema>;

// --------------------------------------------------------------------
// Settings key schemas (extend the M5.7 SETTING_KEYS allowlist)
// --------------------------------------------------------------------

export const promptAnchorEnabledSchema = z.boolean();
export type PromptAnchorEnabled = z.infer<typeof promptAnchorEnabledSchema>;

/** Bounded per-terminal anchor count. Today only `1` is wired. */
export const promptAnchorsMaxPerTerminalSchema = z.number().int().min(1).max(8);
export type PromptAnchorsMaxPerTerminal = z.infer<typeof promptAnchorsMaxPerTerminalSchema>;

/** Renderer-side staleness window. Min 1s, max 10 minutes. */
export const promptAnchorStalenessMsSchema = z
  .number()
  .int()
  .min(1000)
  .max(10 * 60 * 1000);
export type PromptAnchorStalenessMs = z.infer<typeof promptAnchorStalenessMsSchema>;

/**
 * Custom literal allowlist (merged with the built-in allowlist at
 * resolve time, deduplicated, capped at 16 entries total). Each
 * literal is 1..32 chars; the runtime uses `endsWith` only — no
 * regex, no glob, no escaping.
 */
export const promptAnchorLiteralsSchema = z.array(z.string().min(1).max(32)).max(16);
export type PromptAnchorLiterals = z.infer<typeof promptAnchorLiteralsSchema>;
