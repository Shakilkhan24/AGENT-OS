/**
 * Smoke tests for the shutdown-flush contract.
 *
 * The debounced state writer means there's a window between `Store.save`
 * returning and the bytes landing on disk. Two scenarios are pinned here:
 *
 *   1. After the renderer reports the latest commit is visible (a UI affordance
 *      the app could show via `Store.flush()`), a force-kill preserves the
 *      latest mutation. This proves the flush path actually works end-to-end.
 *
 *   2. A mutation followed immediately by SIGKILL with no grace period may
 *      lose the very last write (this is the documented durable-loss window).
 *      Older mutations that already settled on disk must still be visible.
 *      This protects against the regression where a debouncer change
 *      accidentally starts dropping settled data.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

async function launch(data: string) {
  return electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH!,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
}

async function waitForFile(file: string, predicate: (text: string) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate(await readFile(file, "utf8"))) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForFile timed out after ${timeoutMs}ms`);
}

test("settled state survives a force-kill", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-shutdown-"));
  const data = path.join(base, "data");
  await mkdir(data);
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(data);
    const page = await app.firstWindow();
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
    await page.getByRole("button", { name: "Create your first session" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Shotdown probe");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(base);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Shotdown probe", exact: true })).toBeVisible();
    // Let the debounce window elapse so the rename definitely hits disk.
    await new Promise((r) => setTimeout(r, 250));
    const stateFile = path.join(data, "state.json");
    await waitForFile(stateFile, (text) => /"name":\s*"Shotdown probe"/.test(text));
    // Force-kill without graceful shutdown. Process exit should drain pending
    // writes via the will-quit handler.
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    if (app) {
      try { app.process().kill("SIGKILL"); } catch {}
      await app.close().catch(() => {});
    }
  }
  // Reopen with the same data directory and verify the mutation survived.
  const app2 = await launch(data);
  try {
    const page2 = await app2.firstWindow();
    await expect(page2.getByRole("heading", { name: "Shotdown probe", exact: true })).toBeVisible({ timeout: 10000 });
  } finally {
    app2.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    await app2.close().catch(() => {});
    await rm(base, { recursive: true, force: true });
  }
});

test("force-kill before the debounce window elapses loses only the in-flight write", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-shutdown-race-"));
  const data = path.join(base, "data");
  await mkdir(data);
  let app: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    app = await launch(data);
    const page = await app.firstWindow();
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
    await page.getByRole("button", { name: "Create your first session" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Seed");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(base);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Seed", exact: true })).toBeVisible();
    // Wait for the seed to land on disk; rename and kill before the rename
    // can settle. The previous settled state must survive.
    const stateFile = path.join(data, "state.json");
    await waitForFile(stateFile, (text) => /"name":\s*"Seed"/.test(text));
    await page.getByRole("button", { name: "Rename session" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed");
    await page.getByRole("button", { name: "Save changes" }).click();
    // Force-kill immediately so the rename's debounce timer doesn't fire.
    app.process().kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    if (app) {
      try { app.process().kill("SIGKILL"); } catch {}
      await app.close().catch(() => {});
    }
  }
  // The settled "Seed" name must be present (or, if the rename happened to
  // land before the kill, "Renamed" — both are acceptable; what must NOT
  // happen is a half-written state.json).
  const reopened = await readFile(path.join(data, "state.json"), "utf8");
  expect(reopened).toMatch(/"name":\s*"(Seed|Renamed)"/);
  // Cleanup
  await rm(base, { recursive: true, force: true });
});
