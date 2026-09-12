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

async function forceKill(app: Awaited<ReturnType<typeof launch>>) {
  const child = app.process();
  const exited = new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  child.kill("SIGKILL");
  await exited;
  await app.close().catch(() => {});
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
    // UI success follows persistence; SIGKILL cannot run shutdown handlers.
    await forceKill(app);
  } finally {
    if (app) await app.close().catch(() => {});
  }
  // Reopen with the same data directory and verify the mutation survived.
  const app2 = await launch(data);
  try {
    const page2 = await app2.firstWindow();
    await expect(page2.getByRole("heading", { name: "Shotdown probe", exact: true })).toBeVisible({ timeout: 10000 });
  } finally {
    await app2.close();
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("acknowledged rename survives an immediate force-kill", async () => {
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
    // Rename through IPC so this test can kill immediately after acknowledgement.
    await page.evaluate(async () => {
      const current = await window.minimal.snapshot();
      await window.minimal.renameSession(current.sessions[0].id, "Renamed");
    });
    await forceKill(app);
  } finally {
    if (app) await app.close().catch(() => {});
  }
  const reopened = JSON.parse(await readFile(path.join(data, "state.json"), "utf8"));
  expect(reopened.sessions[0].name).toBe("Renamed");
  await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
