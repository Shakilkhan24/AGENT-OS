/**
 * M5.6 — saved layout types + audit digest.
 *
 * `SavedLayout` is persisted under `WorkspaceState.layouts[sessionId]`.
 * The shape is `strict()`-validated by `savedLayoutSchema` in
 * `src/shared/workspace6-schema.ts` so callers parse before commit.
 *
 * Digest contract: `layoutDigest` is SHA-256 over the canonical
 * `{version, sessionId, split, top, bottom}` projection EXCLUDING
 * `layoutDigest` itself AND the volatile `updatedAt` field. Two
 * layouts with identical effective state produce identical digests,
 * so a stale re-save is detectable by digest mismatch.
 */
import { createHash } from "node:crypto";
import type {
  PaneState,
  SavedLayout,
  SplitConfig,
} from "../../shared/workspace6-schema";
import { savedLayoutSchema } from "../../shared/workspace6-schema";
import { stableStringify } from "../db/effective-settings";
import type { State } from "../../shared/types";

/** The shape of `WorkspaceState.layouts`: sessionId → SavedLayout. */
export type LayoutMap = Readonly<Record<string, SavedLayout>>;

/** Migrate a v2 state JSON to v3 by adding an empty `layouts` map. */
export function migrateLayoutV2toV3<S extends { version: number }>(state: S): { version: 3; layouts: Record<string, SavedLayout> } {
  void state;
  return { version: 3, layouts: {} };
}

/** Convert the in-memory `layouts` map to its serialized form for persistence. */
export function serializeLayouts(map: ReadonlyMap<string, SavedLayout>): Record<string, SavedLayout> {
  const out: Record<string, SavedLayout> = {};
  for (const [key, value] of map.entries()) out[key] = value;
  return out;
}

/** Hydrate the in-memory `layouts` map from a parsed state object.
 * Malformed entries (wrong `version`, mismatched `sessionId`, or any
 * unknown top-level field) are dropped — they were probably written
 * by a newer build and the M5.6 strict schema refused them. */
export function hydrateLayouts(state: { layouts?: Record<string, unknown> }): {
  kept: Array<[string, SavedLayout]>;
  dropped: string[];
} {
  const dropped: string[] = [];
  const kept: Array<[string, SavedLayout]> = [];
  if (!state.layouts) return { kept, dropped };
  for (const [sessionId, raw] of Object.entries(state.layouts)) {
    if (raw && typeof raw === "object"
        && (raw as { version?: unknown }).version === 3
        && (raw as { sessionId?: unknown }).sessionId === sessionId) {
      // Parse with the strict schema; extra top-level fields will throw.
      try {
        const parsed = savedLayoutSchema.parse(raw);
        kept.push([sessionId, parsed]);
      } catch {
        dropped.push(sessionId);
      }
    } else {
      dropped.push(sessionId);
    }
  }
  return { kept, dropped };
}

export function emptySavedLayout(
  sessionId: string,
  ratio: number,
  top: PaneState = { activeTerminalId: null, hiddenTerminalIds: [] },
  bottom: PaneState = { activeTerminalId: null, hiddenTerminalIds: [] },
): { split: SplitConfig; top: PaneState; bottom: PaneState; layoutDigest: string } {
  const split: SplitConfig = { enabled: false, ratio };
  return { split, top, bottom, layoutDigest: digestLayout(sessionId, split, top, bottom) };
}

/**
 * Compute the canonical digest for a saved layout EXCLUDING volatile
 * `updatedAt` / `layoutDigest` themselves. Two layouts with the same
 * `(split, top, bottom)` projection produce the same digest.
 */
export function digestLayout(
  sessionId: string,
  split: SplitConfig,
  top: PaneState,
  bottom: PaneState,
): string {
  return createHash("sha256")
    .update(stableStringify({ sessionId, version: 3, split, top, bottom }), "utf8")
    .digest("hex");
}

/**
 * Validate a parsed state object: if it's v2, migrate to v3;
 * otherwise return the state unchanged. Consumers that hydrate the
 * `WorkspaceState.layouts` map should call this BEFORE invoking
 * `hydrateLayouts`.
 */
export function ensureLayoutVersion<S extends { version: number }>(state: S): { version: 3 } & Omit<S, "version"> {
  if (state.version === 3) return state as unknown as { version: 3 } & Omit<S, "version">;
  if (state.version === 2) return migrateLayoutV2toV3(state) as unknown as { version: 3 } & Omit<S, "version">;
  throw new Error(`Unsupported state.version ${(state as { version: number }).version}`);
}

/** Convenience: how many sessionIds have a saved layout in this state. */
export function countLayouts(state: State): number {
  const layouts = (state as unknown as { layouts?: Record<string, unknown> }).layouts;
  return layouts ? Object.keys(layouts).length : 0;
}
