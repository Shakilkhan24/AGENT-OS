/**
 * M9.6 — provider-economics separation freshness test.
 *
 * Two assertions:
 *   1. `docs/provider-economics.md` exists and contains the four
 *      required §-headings (§1-§4 are structural; §5 is the
 *      freshness rule).
 *   2. `src/runtime/pilot/budget-gate.ts` still emits
 *      `AppError("BUDGET_EXCEEDED")` — the refuse-to-spend code the
 *      doc pins as "enforcement, not billing". A future removal MUST
 *      update both the doc and the gate.
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
  /^## 1\. Commitment/m,
  /^## 2\. Audit surfaces/m,
  /^## 3\. The budget gate is enforcement, not billing/m,
  /^## 4\. Portability/m,
  /^## 5\. Freshness rule/m,
];

test("docs/provider-economics.md exists and carries all five required §-headings", async () => {
  const text = await readFile(path.join(REPO_ROOT, "docs/provider-economics.md"), "utf8");
  for (const re of REQUIRED_HEADINGS) {
    assert.ok(re.test(text), `docs/provider-economics.md missing heading matching ${re}`);
  }
});

test("src/runtime/pilot/budget-gate.ts still emits AppError('BUDGET_EXCEEDED')", async () => {
  const text = await readFile(path.join(REPO_ROOT, "src/runtime/pilot/budget-gate.ts"), "utf8");
  assert.ok(
    /new AppError\(\s*"BUDGET_EXCEEDED"/.test(text),
    "budget-gate.ts no longer emits AppError('BUDGET_EXCEEDED') — refuse-to-spend posture has changed; update docs/provider-economics.md and this test together",
  );
  // Also assert the unknown-cost discipline string is still present.
  assert.ok(
    /costUsd === null/.test(text),
    "budget-gate.ts no longer references 'costUsd === null' — unknown-cost discipline has changed; update docs/provider-economics.md §2-§3 and this test together",
  );
});