/**
 * M3c.1 — managed review shell desktop smoke spec.
 *
 * Coverage:
 *  1. The topbar exposes a `Layers2` toggle for the managed review shell.
 *     Pressing it swaps the SessionSidebar for ManagedReview.
 *  2. With no managed work recorded on the profile (the default state for
 *     a fresh profile), ManagedReview renders the "review shell unavailable"
 *     notice because the projection envelope arrives with `available: false`
 *     — either because the DB driver is in-memory (no M3 entities) or
 *     because the schema hasn't been populated.
 *  3. Pressing the toggle again restores the SessionSidebar.
 *
 * Why no populated three-column test here?
 *  The M3a/M3b entities are produced by the orchestrator + execute-once
 *  paths; instrumenting those would require a real provider binary, which
 *  isn't available in this environment. The projection's entity
 *  behaviour is covered exhaustively by
 *  `tests/runtime/managed-projection.test.ts` (7 cases). This spec just
 *  verifies the renderer surface wires correctly to the projection.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-managed-review-"));
  const root = path.join(base, "project"), data = path.join(base, "data");
  await mkdir(root); await mkdir(data);
  await writeFile(path.join(data, "settings.json"), JSON.stringify({ shellMode: "clean" }));
  const launch = () => electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
  let app = await launch();
  const page = await app.firstWindow();
  page.on("dialog", dialog => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  await page.evaluate(root => window.minimal.createSession("Managed review fixture", root), root);
  return { page, base,
    async close() {
      await app.close().catch(() => {});
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("managed review toggle swaps the session sidebar for the unavailable notice", async () => {
  const ctx = await fixture();
  const { page } = ctx;
  try {
    // The toggle is the icon-only `Layers2` button next to the explorer
    // toggle in the session header. Its accessible label switches
    // depending on the current state.
    const toggle = page.getByRole("button", { name: /Show managed review|Hide managed review/ });
    await expect(toggle).toBeVisible();
    await toggle.click();
    // Sidebar is gone, ManagedReview renders the unavailable notice because
    // no M3 entities exist on this profile (the in-memory driver or a
    // fresh SQLite DB both yield a `db-closed` or empty projection).
    await expect(page.getByRole("heading", { name: "Review shell unavailable on this profile." })).toBeVisible();
    await expect(page.getByRole("region", { name: "Tasks" })).toHaveCount(0);
    // Toggling back restores the sidebar.
    const restore = page.getByRole("button", { name: /Switch back to the session sidebar/ });
    await restore.click();
    await expect(page.getByRole("heading", { name: "Managed review fixture", exact: true })).toBeVisible();
    await expect(page.getByText("Sessions", { exact: true })).toBeVisible();
  } finally { await ctx.close(); }
});

test("managed review toggle persists across reload", async () => {
  const ctx = await fixture();
  const { page } = ctx;
  try {
    await page.getByRole("button", { name: /Show managed review/ }).click();
    await expect(page.getByRole("heading", { name: "Review shell unavailable on this profile." })).toBeVisible();
    // Force the renderer to reload from disk; localStorage should
    // restore `managed` mode without needing a fresh toggle.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Review shell unavailable on this profile." })).toBeVisible();
    await page.getByRole("button", { name: /Switch back to the session sidebar/ }).click();
    await page.reload();
    await expect(page.getByText("Sessions", { exact: true })).toBeVisible();
  } finally { await ctx.close(); }
});

test("managed review unavailable path does not render the Approve button or the Review actions", async () => {
  // The M3c.2 panels live inside TaskDetail which only renders when
  // `managed.available === true` and a task is selected. On a fresh
  // profile with no M3 entities, the projection envelope arrives as
  // `{available: false}`; the buttons must not appear because there is
  // no task to approve and no review to act on.
  const ctx = await fixture();
  const { page } = ctx;
  try {
    await page.getByRole("button", { name: /Show managed review/ }).click();
    await expect(page.getByRole("heading", { name: "Review shell unavailable on this profile." })).toBeVisible();
    await expect(page.getByRole("button", { name: /Approve and run verifier/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Accept review/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Reject review/ })).toHaveCount(0);
  } finally { await ctx.close(); }
});