/**
 * M6.1 wiring — workflow runner headless DOM contract.
 *
 * These three tests prove the first renderer-side call site for
 * `window.minimal.runWorkflow(...)`. They are the headless DOM
 * equivalent of the IPC envelope tests in
 * `tests/runtime/workflow-ipc.test.ts` — they exercise the
 * renderer side; the dispatcher/parseRequest/middleware side is
 * already covered there.
 *
 * The tests are deliberately small: no full workflow execution,
 * no provider integration. They assert the visible envelope
 * shape (`kind:"ok"` / `kind:"conflict"`) and the gate behaviour
 * that links this widget to the `localStorage("minimal.advanced")`
 * flag from M9.3.
 */
import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxEngine } from "../../src/main/engine";

async function fixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-workflow-runner-"));
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
  // The workflow.run palette action has scope "session" — we need a
  // session for the command to surface.
  await page.evaluate(async (root) => {
    await window.minimal.createSession("WorkflowRunner", root);
  }, root);
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

test("palette → Run inline workflow opens the dialog and focuses the JSON editor", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.locator("body").click();
    await page.keyboard.press("Control+Shift+P");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    // Filter to the new command.
    const search = palette.getByRole("textbox", { name: "Search" });
    await search.fill("workflow");
    await palette.getByRole("option", { name: /Run inline workflow/ }).click();
    const dialog = page.getByRole("dialog", { name: "Workflow runner" });
    await expect(dialog).toBeVisible();
    // The JSON editor must be present.
    await expect(dialog.getByRole("textbox", { name: "Workflow graph JSON" })).toBeVisible();
    // The Run inline button is the enabled primary action.
    await expect(dialog.getByTestId("workflow-run-inline")).toBeEnabled();
    // The Run durable button is rendered but disabled when Advanced
    // controls are off (the M9.3 gate, default off).
    const durable = dialog.getByTestId("workflow-run-durable");
    await expect(durable).toBeDisabled();
    await expect(durable).toHaveAttribute("aria-disabled", "true");
  } finally { await ctx.close(); }
});

test("Run inline on a hello-world graph renders kind:'ok' envelope in the result region", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.locator("body").click();
    await page.keyboard.press("Control+Shift+P");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("textbox", { name: "Search" })
      .fill("workflow");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("option", { name: /Run inline workflow/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "Workflow runner" });
    // The default fixture is hello-world (one `/bin/echo hello` step).
    await expect(dialog.getByRole("combobox", { name: "Workflow fixture" }))
      .toHaveValue("hello-world");
    await dialog.getByTestId("workflow-run-inline").click();
    // Result region with the discriminated union shape.
    const result = dialog.getByTestId("workflow-result");
    await expect(result).toBeVisible({ timeout: 8000 });
    // The envelope heading carries the workflowId from the fixture.
    await expect(result.getByText("hello-world")).toBeVisible();
    // The step-output table has at least one row (the echo step).
    const rows = result.locator("tbody tr");
    await expect(rows.first()).toBeVisible();
  } finally { await ctx.close(); }
});

test("Run inline on the cycle-broken fixture renders kind:'conflict' red-bordered region", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    await page.locator("body").click();
    await page.keyboard.press("Control+Shift+P");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("textbox", { name: "Search" })
      .fill("workflow");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("option", { name: /Run inline workflow/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "Workflow runner" });
    await dialog.getByRole("combobox", { name: "Workflow fixture" }).selectOption("cycle-broken");
    await dialog.getByTestId("workflow-run-inline").click();
    const conflict = dialog.getByTestId("workflow-conflict");
    await expect(conflict).toBeVisible({ timeout: 4000 });
    // The conflict reason must mention a cycle — the dispatcher
    // wraps the cycle gate's reason string.
    const text = await conflict.textContent();
    expect(text?.toLowerCase()).toMatch(/cycle|dependency|edge/);
  } finally { await ctx.close(); }
});

test("Run durable button enables only after the M9.3 advanced-controls gate is on", async () => {
  const ctx = await fixture();
  try {
    const { page } = ctx;
    // Set the gate BEFORE the renderer mounts so the initial
    // `isAdvancedEnabled()` read returns true.
    await page.addInitScript(() => {
      localStorage.setItem("minimal.advanced", "on");
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "WorkflowRunner", exact: true })).toBeVisible();
    await page.locator("body").click();
    await page.keyboard.press("Control+Shift+P");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("textbox", { name: "Search" })
      .fill("workflow");
    await page.getByRole("dialog", { name: "Command palette" })
      .getByRole("option", { name: /Run inline workflow/ })
      .click();
    const dialog = page.getByRole("dialog", { name: "Workflow runner" });
    const durable = dialog.getByTestId("workflow-run-durable");
    await expect(durable).toBeEnabled();
    // Clicking Run durable with the hello-world graph also returns a
    // kind:"ok" envelope (the typed envelope is the same; the
    // difference is that the runtime persists a `workflow_run` row).
    await durable.click();
    await expect(dialog.getByTestId("workflow-result")).toBeVisible({ timeout: 8000 });
  } finally { await ctx.close(); }
});
