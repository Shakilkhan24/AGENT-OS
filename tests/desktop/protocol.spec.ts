import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { TmuxEngine } from "../../src/main/engine";

test("a malformed terminal event is rejected and surfaces a visible protocol failure", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-protocol-desktop-"));
  const root = path.join(base, "project"), data = path.join(base, "profile");
  await mkdir(root);
  const app = await electron.launch({ executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."], env: { ...process.env, MINIMAL_DATA_DIR: data } });
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
    const version = await app.evaluate(({ app }) => app.getVersion());
    await expect(page.locator(".app-footer")).toContainText(`MINIMAL ${version}`);
    const changed = await page.evaluate(async root => {
      let notify!: () => void;
      const change = new Promise<void>(resolve => { notify = resolve; });
      const unsubscribe = window.minimal.onWorkspaceChanged(notify);
      const state = await window.minimal.createSession("Protocol test", root);
      try {
        await window.minimal.launchTerminals(state.sessions[0].id, { command: "sleep 600" });
        await change;
        return true;
      } finally { unsubscribe(); }
    }, root);
    expect(changed).toBe(true);
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("terminal-output", {
        apiVersion: 99, args: [crypto.randomUUID(), "untrusted output"],
      });
    });
    await expect(page.locator(".error-toast")).toContainText("Incompatible MINIMAL API");
    const state = await page.evaluate(() => window.minimal.snapshot());
    expect(state.sessions[0].terminals[0].status).toBe("running");
    const rejected = await page.evaluate(() => {
      try { window.minimal.resize("invalid", 0, -1); return false; }
      catch { return true; }
    });
    expect(rejected).toBe(true);
  } finally {
    await app.close().catch(() => {});
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(base, { recursive: true, force: true });
  }
});
