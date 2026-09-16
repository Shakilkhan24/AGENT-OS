/**
 * M5.6 — pure command-palette logic (testable without a DOM).
 *
 * Splitting the fuzzy-matcher + command-resolver out of the React
 * component lets us unit-test the matching algorithm with node:test.
 * The React layer (`CommandPalette.tsx`) imports `scoreCommand` and
 * `selectCommands` from here so the same code path drives the UI and
 * the tests.
 */

export interface PaletteCommand {
  readonly id: string;
  readonly label: string;
  readonly aliases?: readonly string[];
  readonly scope: "session" | "terminal" | "global";
}

export interface ScoredCommand {
  readonly command: PaletteCommand;
  readonly score: number;
}

/**
 * Lowercased substring match scored by first-hit index. Smaller score
 * ranks higher (so a prefix hit at index 0 beats index 5). Returns
 * `null` when no substring match exists.
 */
export function scoreCommand(query: string, command: PaletteCommand): number | null {
  if (query.length === 0) return 0;
  const haystacks = [command.label, ...(command.aliases ?? [])].map((s) => s.toLowerCase());
  const needle = query.toLowerCase();
  let best: number | null = null;
  for (const hay of haystacks) {
    const idx = hay.indexOf(needle);
    if (idx === -1) continue;
    const candidate = idx;
    if (best === null || candidate < best) best = candidate;
  }
  return best;
}

/**
 * Pick the top-N commands whose label/aliases contain the query as a
 * substring. Ties broken by `id` lexicographic order. Returns commands
 * in deterministic order: ascending score, then ascending id.
 */
export function selectCommands(
  commands: readonly PaletteCommand[],
  query: string,
  limit: number,
): readonly ScoredCommand[] {
  const scored: ScoredCommand[] = [];
  for (const command of commands) {
    const score = scoreCommand(query, command);
    if (score !== null) scored.push({ command, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.command.id.localeCompare(b.command.id);
  });
  return scored.slice(0, limit);
}

/**
 * Filter commands by scope. `session` commands appear only when a
 * session is focused; `terminal` commands only when a terminal is
 * focused; `global` commands always appear.
 */
export function filterByScope(
  commands: readonly PaletteCommand[],
  ctx: { sessionFocused: boolean; terminalFocused: boolean },
): readonly PaletteCommand[] {
  return commands.filter((c) => {
    if (c.scope === "global") return true;
    if (c.scope === "session") return ctx.sessionFocused;
    if (c.scope === "terminal") return ctx.terminalFocused;
    return false;
  });
}

/** Read the most recently used command ids from `localStorage`. */
export function readRecentCommands(localStorageValue: string | null, limit: number): readonly string[] {
  if (!localStorageValue) return [];
  try {
    const parsed = JSON.parse(localStorageValue) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string").slice(0, limit);
  } catch {
    return [];
  }
}

/** Persist a freshly-invoked command id to `localStorage`, deduped. */
export function pushRecentCommand(
  previousJson: string | null,
  commandId: string,
  limit: number,
): string {
  const previous = readRecentCommands(previousJson, limit);
  const next = [commandId, ...previous.filter((id) => id !== commandId)].slice(0, limit);
  return JSON.stringify(next);
}
