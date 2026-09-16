/**
 * M5.6 — SessionHeader pure logic.
 *
 * The session-header component renders tag chips (max 6 + overflow),
 * a color stripe, and an archive toggle. The chip-overflow logic is
 * split out so tests can exercise the rendering rules without a DOM.
 */
import type { SessionMetadata } from "../shared/models";

export const MAX_VISIBLE_TAGS = 6;

/** What the SessionHeader renders when a session has N tags. */
export interface TagChipLayout {
  readonly visible: readonly string[];
  readonly overflowCount: number;
}

/** Split a session's tag list into the visible chips + the overflow count. */
export function layoutTagChips(metadata: SessionMetadata): TagChipLayout {
  const tags = metadata.tags;
  if (tags.length <= MAX_VISIBLE_TAGS) return { visible: tags, overflowCount: 0 };
  const visible = tags.slice(0, MAX_VISIBLE_TAGS);
  return { visible, overflowCount: tags.length - MAX_VISIBLE_TAGS };
}

/** Compute the CSS color value for the session stripe (or a default). */
export function sessionStripeColor(metadata: SessionMetadata, fallback: string): string {
  return metadata.color ?? fallback;
}

/** Toggle the `archived` flag and return the new state. */
export function toggleArchived(metadata: SessionMetadata): SessionMetadata {
  return { ...metadata, archived: !metadata.archived };
}
