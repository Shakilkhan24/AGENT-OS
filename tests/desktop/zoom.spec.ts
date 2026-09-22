/**
 * M9.3 — 200% zoom reflow contract.
 *
 * Electron's `webContents.setZoomFactor(2.0)` is the real-world path,
 * but the Playwright `_electron` harness does not surface that API
 * directly to the renderer test process. We emulate the equivalent by
 * bumping the root `font-size` to 26px (1rem = 13px at 100% zoom, so
 * 26px is exactly the 200% reflow the layout tokens were designed for).
 *
 * The contract: at 200%, the topbar and sidebar MUST NOT clip
 * horizontally. The file panel's labels truncate with ellipsis; the
 * `.terminal-caption` and `.empty-terminals` paragraphs reflow inside
 * their containers.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxEngine } from "../../src/main/engine";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-zoom-"));
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
  const app = await launch();
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

test("200% effective zoom does not clip the topbar horizontally", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    // Emulate the 200% reflow by bumping the root font-size to 26px.
    await page.evaluate(() => {
      const root = document.documentElement;
      root.style.fontSize = "26px";
    });
    const topbar = page.locator(".topbar");
    const metrics = await topbar.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    // Allow a 1px rounding error.
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    // Reset for any later tests that share the page object.
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "";
    });
  } finally { await ctx.close(); }
});

test("200% effective zoom does not overflow the viewport width", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "26px";
    });
    const metrics = await page.evaluate(() => ({
      bodyScrollWidth: document.body.scrollWidth,
      bodyClientWidth: document.body.clientWidth,
      viewportWidth: window.innerWidth,
    }));
    expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  } finally { await ctx.close(); }
});