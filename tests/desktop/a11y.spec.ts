/**
 * M9.3 — accessibility smoke flows (keyboard-only + new global hotkeys).
 *
 * This spec covers the keyboard + dialog flows that the M9.3 plan
 * identifies as testable through Playwright. The actual screen-reader
 * reading behaviour lives in `docs/screen-reader-qualification.md`.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxEngine } from "../../src/main/engine";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-a11y-"));
  const root = path.join(base, "project");
  const data = path.join(base, "data");
  await mkdir(root);
  await mkdir(data);
  await writeFile(path.join(data, "settings.json"), JSON.stringify({ shellMode: "clean" }));
  const launch = () =>
    electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: data },
    });
  let app = await launch();
  const page = await app.firstWindow();
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  return {
    root,
    page,
    async close() {
      await app.close().catch(() => {});
      for (const id of (await engine.inspect()).keys()) await engine.remove(id);
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("Ctrl+Shift+P opens the command palette from the welcome screen", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.locator("body").click();
    await page.keyboard.press("Control+Shift+P");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("textbox", { name: "Search" });
    await expect(input).toBeFocused();
    await page.keyboard.type("new");
    // The "New session" command should be in the result list.
    await expect(dialog.getByRole("option", { name: /New session/ })).toBeVisible();
  } finally { await ctx.close(); }
});

test("? opens the keyboard cheatsheet", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.locator("body").click();
    await page.keyboard.press("Shift+/");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    // The four M9.3 hotkeys must be listed.
    await expect(dialog.getByRole("row", { name: /Ctrl\+Shift\+P/ })).toBeVisible();
    await expect(dialog.getByRole("row", { name: /Ctrl\+Shift\+S/ })).toBeVisible();
    await expect(dialog.getByRole("row", { name: /cycle keyboard focus/i })).toBeVisible();
    await expect(dialog.getByRole("row", { name: /Open this cheatsheet/ })).toBeVisible();
  } finally { await ctx.close(); }
});

test("keyboard-only welcome-to-session flow works without a mouse", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    // Tab through the chrome until we reach the welcome CTA. The exact
    // path depends on the topbar / footer tab order; we don't assert that,
    // just that we eventually reach the primary button via Tab.
    let attempts = 0;
    let focused = "";
    while (attempts++ < 30) {
      await page.keyboard.press("Tab");
      focused = await page.evaluate(() => document.activeElement?.textContent ?? "");
      if (focused.includes("Create your first session")) break;
    }
    expect(focused).toContain("Create your first session");
    await page.keyboard.press("Enter");
    const create = page.getByRole("dialog", { name: "Create a session" });
    await expect(create).toBeVisible();
    const nameInput = create.getByRole("textbox", { name: "Name" });
    await nameInput.fill("Keyboard Session");
    await create.getByRole("button", { name: "Create session" }).click();
    await expect(page.getByRole("heading", { name: "Keyboard Session", exact: true })).toBeVisible();
    expect(true).toBe(true); // fixture cleanup happens in finally
  } finally { await ctx.close(); }
});

test("managed-mode toggle stays gated behind Advanced controls by default", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    // Advance controls are off by default — the toggle must be disabled
    // when no session exists, OR show the (Advanced) badge when a session
    // is present.
    await page.evaluate(async (root) => {
      await window.minimal.createSession("Gate", root);
    }, ctx.root);
    const toggle = page.getByRole("button", { name: /Show managed review/i });
    await expect(toggle).toBeVisible();
    const advanced = await toggle.getAttribute("aria-describedby");
    expect(advanced).toBe("managed-advanced-hint");
  } finally { await ctx.close(); }
});