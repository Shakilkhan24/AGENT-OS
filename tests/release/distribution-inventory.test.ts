/**
 * M9.6 — distribution-inventory freshness test.
 *
 * Three assertions:
 *   1. `docs/distribution.md` exists and contains the four required
 *      §-headings (§1 Shipped tree, §2 License matrix, §3 Update mechanism,
 *      §4 Freshness rule). The §5/§6 sections are documentation-only
 *      but their presence is asserted by structural pattern matching.
 *   2. `scripts/verify-release.mts` still carries the "unsigned"
 *      disclaimer. A future signer MUST update both this doc and the
 *      script in the same commit; the test failure is the signal.
 *   3. `scripts/package.mjs` still aborts on non-Linux platforms.
 *      A future multi-platform packager MUST update this doc and the
 *      script together.
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
  /^## 1\. Shipped tree/m,
  /^## 2\. License matrix/m,
  /^## 3\. Update mechanism/m,
  /^## 4\. Freshness rule/m,
  /^## 5\. Counsel-gate reminder/m,
  /^## 6\. Out of scope/m,
];

test("docs/distribution.md exists and carries all six required §-headings", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/distribution.md"), "utf8");
  for (const re of REQUIRED_HEADINGS) {
    assert.ok(re.test(text), `docs/distribution.md missing heading matching ${re}`);
  }
});

test("scripts/verify-release.mts still carries the 'unsigned' disclaimer", async () => {
  const text = await readFile(path.join(REPO_ROOT, "scripts/verify-release.mts"), "utf8");
  assert.ok(
    /release artifact is currently unsigned/i.test(text),
    "verify-release.mts no longer carries the 'unsigned' disclaimer — the boundary has changed; update docs/distribution.md and this test together",
  );
});

test("scripts/package.mjs still aborts on non-linux platforms", async () => {
  const text = await readFile(path.join(REPO_ROOT, "scripts/package.mjs"), "utf8");
  assert.ok(
    /process\.platform\s*!==\s*"linux"/.test(text),
    "package.mjs no longer aborts on non-linux — multi-platform packaging landed; update docs/distribution.md and this test together",
  );
  assert.ok(
    /Build the Linux application from Linux or WSL/.test(text),
    "package.mjs Linux-only message has been reworded; update docs/distribution.md §3 quote to match",
  );
});