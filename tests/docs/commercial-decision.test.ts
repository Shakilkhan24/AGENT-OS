/**
 * M9.6 — commercial-decision record freshness test.
 *
 * Three assertions:
 *   1. `docs/commercial-decision.md` exists and contains the six
 *      required §-headings.
 *   2. The doc references all four boundary docs (`distribution`,
 *      `security`, `provider-economics`, `cancel-and-walk-away`)
 *      by relative path — guards against dangling pointers if any
 *      of those boundary docs are renamed or removed in a future
 *      milestone.
 *   3. The doc quotes research doc 12 line 82 verbatim — guards
 *      against paraphrase drift on the portability commitment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = (() => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
})();

const REQUIRED_HEADINGS = [
  /^## 1\. Decision/m,
  /^## 2\. What this decision pins/m,
  /^## 3\. Reversal criteria/m,
  /^## 4\. Support-cost model — explicit absence/m,
  /^## 5\. Portability commitment/m,
  /^## 6\. Freshness rule/m,
];

test("docs/commercial-decision.md exists and carries all six required §-headings", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/commercial-decision.md"), "utf8");
  for (const re of REQUIRED_HEADINGS) {
    assert.ok(re.test(text), `docs/commercial-decision.md missing heading matching ${re}`);
  }
});

test("docs/commercial-decision.md references all four boundary docs by relative path", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/commercial-decision.md"), "utf8");
  // The four boundary docs the M9.6 cut pins. Each must be referenced
  // by relative path so a future rename forces both the boundary doc
  // and the decision record to move together.
  const requiredRefs = [
    /docs\/distribution\.md/,
    /docs\/security\.md/,
    /docs\/provider-economics\.md/,
    /docs\/runbooks\/cancel-and-walk-away\.md/,
  ];
  for (const re of requiredRefs) {
    assert.ok(re.test(text), `docs/commercial-decision.md missing reference matching ${re}`);
  }
});

test("docs/commercial-decision.md quotes research doc 12 line 82 portability commitment verbatim", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/commercial-decision.md"), "utf8");
  // The portability commitment verbatim — guards against paraphrase
  // drift. The doc must quote the research doc's literal text.
  const VERBATIM_FRAGMENT = "Keep project files, already-created results, essential recovery,";
  assert.ok(
    text.includes(VERBATIM_FRAGMENT),
    `docs/commercial-decision.md no longer quotes research doc 12 line 82 verbatim — paraphrase drift; update the doc and this test together`,
  );
});
