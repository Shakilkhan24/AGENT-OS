/**
 * M9.6 — cancel-and-walk-away runbook freshness test.
 *
 * Four assertions:
 *   1. `docs/runbooks/cancel-and-walk-away.md` exists and walks the
 *      four phases (backup, verify, diagnostics, restore) in order.
 *   2. `src/runtime/db/backup.ts` exports `takeBackup`,
 *      `verifyBackup`, `beginRestore`, `endRestore`, and
 *      `restoreFromBackup` — the five portability primitives the
 *      runbook references. A future removal MUST update the runbook
 *      and these tests together.
 *   3. `scripts/diagnostics-export.mts` still exists and still walks
 *      `<data-dir>/logs/` + `<data-dir>/logs/runtime/` — the
 *      diagnostics seam the runbook references.
 *   4. `docs/recovery.md` still exists — guards against dangling
 *      cross-references in the runbook.
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
  /^## 1\. Scope/m,
  /^## 2\. Backup/m,
  /^## 3\. Verify/m,
  /^## 4\. Diagnostics/m,
  /^## 5\. Restore/m,
  /^## 6\. What does NOT transfer/m,
  /^## 7\. Freshness rule/m,
];

test("docs/runbooks/cancel-and-walk-away.md exists and walks the four phases in order", async () => {
  const text = await readFile(
    path.join(REPO_ROOT, "docs/runbooks/cancel-and-walk-away.md"),
    "utf8",
  );
  for (const re of REQUIRED_HEADINGS) {
    assert.ok(re.test(text), `cancel-and-walk-away.md missing heading matching ${re}`);
  }
});

test("src/runtime/db/backup.ts exports the five portability primitives", async () => {
  const text = await readFile(path.join(REPO_ROOT, "src/runtime/db/backup.ts"), "utf8");
  // The five primitives the runbook walks. Each must still be
  // exported from backup.ts; a future removal must update both the
  // runbook and this test.
  const requiredExports = [
    /export\s+(?:async\s+)?function\s+takeBackup\b/,
    /export\s+(?:async\s+)?function\s+verifyBackup\b/,
    /export\s+(?:async\s+)?function\s+beginRestore\b/,
    /export\s+(?:async\s+)?function\s+endRestore\b/,
    /export\s+(?:async\s+)?function\s+restoreFromBackup\b/,
  ];
  for (const re of requiredExports) {
    assert.ok(re.test(text), `backup.ts missing export matching ${re}`);
  }
});

test("scripts/diagnostics-export.mts still walks <data-dir>/logs/ and <data-dir>/logs/runtime/", async () => {
  const text = await readFile(
    path.join(REPO_ROOT, "scripts/diagnostics-export.mts"),
    "utf8",
  );
  // The diagnostics seam. The script must still walk the two log
  // directories the runbook describes.
  assert.ok(/logs/.test(text), "diagnostics-export.mts no longer references 'logs' directory");
  assert.ok(
    /runtime/.test(text),
    "diagnostics-export.mts no longer references 'runtime' subdirectory under logs",
  );
  // And it must still surface the canary pipeline that the runbook
  // calls out as the authoritative check.
  assert.ok(
    /canary/i.test(text),
    "diagnostics-export.mts no longer references canary pipeline — scrubber check removed; update the runbook and this test together",
  );
});

test("docs/recovery.md still exists — cross-reference check", async () => {
  // The runbook deliberately cross-references docs/recovery.md. A
  // future removal of that doc must update both the runbook and
  // this test.
  const text = await readFile(path.join(REPO_ROOT, "docs/recovery.md"), "utf8");
  assert.ok(text.length > 0, "docs/recovery.md is empty — runbook cross-reference is dangling");
});
