import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxEngine } from "../../src/main/engine";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-foundation-"));
  const root = path.join(base, "project"), data = path.join(base, "data");
  await mkdir(root); await mkdir(data);
  await writeFile(path.join(root, "note.txt"), "original on disk\n");
  await writeFile(path.join(data, "settings.json"), JSON.stringify({ shellMode: "clean" }));
  const launch = () => electron.launch({ executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."], env: { ...process.env, MINIMAL_DATA_DIR: data } });
  let app = await launch();
  const page = await app.firstWindow();
  page.on("dialog", dialog => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  await page.evaluate(root => window.minimal.createSession("Foundation", root), root);
  await expect(page.getByRole("heading", { name: "Foundation", exact: true })).toBeVisible();
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  return { root, page,
    async crashAndReopen() {
      const child = app.process();
      const exit = new Promise<void>(resolve => child.once("exit", () => resolve()));
      child.kill("SIGKILL"); await exit; await app.close().catch(() => {});
      app = await launch();
      const page = await app.firstWindow();
      page.on("dialog", dialog => void dialog.accept().catch(() => {}));
      return page;
    },
    async close() {
      await app.close().catch(() => {});
      for (const id of (await engine.inspect()).keys()) await engine.remove(id);
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("terminal tabs support roving keyboard navigation without activating on arrows", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.evaluate(async () => {
      const snapshot = await window.minimal.snapshot();
      await window.minimal.createTerminals(snapshot.sessions[0].id, snapshot.presets[0].id, 3, "");
    });
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    const selected = await page.locator('[role="tab"][aria-selected="true"]').textContent();
    await tabs.first().focus();
    await page.keyboard.press("ArrowLeft");
    await expect(tabs.last()).toBeFocused();
    await page.keyboard.press("Home");
    await expect(tabs.first()).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveText(selected!);
    await page.keyboard.press("End");
    await expect(tabs.last()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tabs.last()).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  } finally { await ctx.close(); }
});

test("dialogs have accessible names, contain keyboard focus and restore the opener", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    const opener = page.getByRole("button", { name: "Launch terminals", exact: true });
    await opener.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Launch terminals", exact: true });
    await expect(dialog).toBeVisible();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
  } finally { await ctx.close(); }
});

test("an acknowledged Unicode draft survives SIGKILL and restores as unsaved", async () => {
  const ctx = await fixture();
  const content = "Recovered αβγ 🌍\nDo not auto-save or execute.\n";
  try {
    // Await the real persistence acknowledgement, then kill without unload handlers.
    await ctx.page.evaluate(async content => {
      const state = await window.minimal.snapshot();
      const sessionId = state.sessions[0].id;
      const preview = await window.minimal.files(sessionId, { action: "preview", path: "note.txt" });
      await window.minimal.saveDraft({ sessionId, path: "note.txt", baseHash: preview.hash!, content });
    }, content);
    const page = await ctx.crashAndReopen();
    await page.getByRole("button", { name: /1 recovery draft/ }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "File contents" })).toHaveValue(content);
    await expect(page.getByRole("button", { name: "Save file", exact: true })).toBeEnabled();
    expect(await readFile(path.join(ctx.root, "note.txt"), "utf8")).toBe("original on disk\n");
  } finally { await ctx.close(); }
});
