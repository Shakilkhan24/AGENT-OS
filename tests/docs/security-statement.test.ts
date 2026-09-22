/**
 * M9.6 — security-statement freshness test.
 *
 * Two assertions:
 *   1. `docs/security.md` exists and contains the four required
 *      §-headings (§1-§4 are structural; §5/§6 are documentation).
 *   2. `src/shared/errors.ts:failureSchema.code` still enumerates
 *      `FORBIDDEN`, `LEASE_HELD`, and `LEASE_UNCERTAIN` — the three
 *      authorization-bearing failure codes the doc references.
 *      A future removal MUST update both the doc and the schema.
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
  /^## 1\. The principal model is local-only/m,
  /^## 2\. Anti-self-approval rule/m,
  /^## 3\. Failure codes are intra-runtime/m,
  /^## 4\. What MINIMAL does NOT do/m,
  /^## 5\. Delegation limits/m,
  /^## 6\. Freshness rule/m,
];

test("docs/security.md exists and carries all six required §-headings", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/security.md"), "utf8");
  for (const re of REQUIRED_HEADINGS) {
    assert.ok(re.test(text), `docs/security.md missing heading matching ${re}`);
  }
});

test("src/shared/errors.ts:failureSchema.code still enumerates FORBIDDEN + LEASE_HELD + LEASE_UNCERTAIN", async () => {
  const text = await readFile(path.join(REPO_ROOT, "src/shared/errors.ts"), "utf8");
  for (const code of ["FORBIDDEN", "LEASE_HELD", "LEASE_UNCERTAIN"]) {
    assert.ok(
      new RegExp(`"${code}"`).test(text),
      `failureSchema.code no longer enumerates "${code}" — boundary has changed; update docs/security.md and this test together`,
    );
  }
});