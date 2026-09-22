/**
 * M5.6 — SessionHeader pure-logic tests.
 *
 * Coverage (4 focused tests):
 *  - layoutTagChips returns up to MAX_VISIBLE_TAGS with the overflow count
 *  - layoutTagChips returns the full list when below the cap
 *  - sessionStripeColor falls back to a default when metadata.color is absent
 *  - toggleArchived flips the boolean without mutating the input
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_VISIBLE_TAGS,
  layoutTagChips,
  sessionStripeColor,
  toggleArchived,
} from "../../src/renderer/session-header-logic";
import { sessionMetadataSchema } from "../../src/shared/models";

test("layoutTagChips returns up to MAX_VISIBLE_TAGS + an overflow count", () => {
  const tags = Array.from({ length: MAX_VISIBLE_TAGS + 3 }, (_, i) => `t${i}`);
  const md = sessionMetadataSchema.parse({ tags });
  const layout = layoutTagChips(md);
  assert.equal(layout.visible.length, MAX_VISIBLE_TAGS);
  assert.equal(layout.overflowCount, 3);
});

test("layoutTagChips returns the full list when below the cap", () => {
  const tags = ["alpha", "beta", "gamma"];
  const md = sessionMetadataSchema.parse({ tags });
  const layout = layoutTagChips(md);
  assert.deepEqual(layout.visible, ["alpha", "beta", "gamma"]);
  assert.equal(layout.overflowCount, 0);
});

test("layoutTagChips returns empty visible + 0 overflow when no tags", () => {
  const md = sessionMetadataSchema.parse({});
  const layout = layoutTagChips(md);
  assert.deepEqual(layout.visible, []);
  assert.equal(layout.overflowCount, 0);
});

test("sessionStripeColor falls back when metadata.color is absent", () => {
  const md = sessionMetadataSchema.parse({});
  assert.equal(sessionStripeColor(md, "var(--accent)"), "var(--accent)");
  const coloured = sessionMetadataSchema.parse({ color: "#aB12cD" });
  assert.equal(sessionStripeColor(coloured, "var(--accent)"), "#aB12cD");
});

test("toggleArchived flips the boolean without mutating the input", () => {
  const md = sessionMetadataSchema.parse({ archived: false });
  const flipped = toggleArchived(md);
  assert.equal(flipped.archived, true);
  assert.equal(md.archived, false, "input must remain untouched");
  const flippedAgain = toggleArchived(flipped);
  assert.equal(flippedAgain.archived, false);
});
