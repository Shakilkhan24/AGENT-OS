import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { TmuxEngine } from "../src/main/engine";
test("file conflicts, recovery drafts and virtual directory rows work across restart", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-recovery-ui-"));
  const root = path.join(base, "project"), data = path.join(base, "profile");
  await mkdir(root);
  await writeFile(path.join(root, "notes.txt"), "original");
  const launch = () => electron.launch({ executablePath: process.env.MINIMAL_ELECTRON_PATH, args: ["."], env: { ...process.env, MINIMAL_DATA_DIR: data } });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.evaluate(directory => window.minimal.createSession("Recovery project", directory), root);
    await page.getByRole("option", { name: "notes.txt", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "File contents" }).fill("my unsaved work");
    await expect.poll(async () => (await readdir(path.join(data, "drafts"))).filter(name => name.endsWith(".json")).length).toBe(1);
    await writeFile(path.join(root, "notes.txt"), "external version");
    await page.getByRole("button", { name: "Save file", exact: true }).click();
    await expect(page.getByLabel("Current disk contents")).toHaveText("external version");
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe("external version");
    await page.getByRole("button", { name: "Keep editing", exact: true }).click();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Keep draft and close", exact: true }).click();
    await app.close(); app = await launch(); page = await app.firstWindow();
    await page.getByRole("button", { name: "1 recovery draft", exact: true }).click();
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "File contents" })).toHaveValue("my unsaved work");
    await page.getByRole("button", { name: "Save file", exact: true }).click();
    await page.getByRole("button", { name: "Replace reviewed version", exact: true }).click();
    await expect(page.getByText("Saved · UTF-8")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await Promise.all(Array.from({ length: 550 }, (_, index) => writeFile(path.join(root, `entry-${index}`), "")));
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.locator(".file-footer")).toContainText("200 items");
    expect(await page.locator(".file-row").count()).toBeLessThan(50);
    await page.getByRole("listbox", { name: "Files" }).evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect.poll(async () => (await page.locator(".file-footer").innerText()).includes("200 items")).toBe(false);
    expect(await page.locator(".file-row").count()).toBeLessThan(50);
  } finally { await app.close().catch(() => {}); await rm(base, { recursive: true, force: true }); }
});
test("desktop workflows, real terminal input, file editing, and closing/reopening", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-desktop-"));
  const root = path.join(base, "project");
  await mkdir(root);
  const data = path.join(base, "data");
  const launch = () =>
    electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: data },
    });
  let app = await launch();
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  try {
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Your work, still running." }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Create your first session" })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Studio website");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
    await page
      .getByRole("button", { name: "Create session", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("heading", { name: "Studio website", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Launch terminals", exact: true })
      .click();
    await page
      .getByRole("spinbutton", { name: "Number of terminals" })
      .fill("2");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type("printf 'PERSISTENCE-CHECK\\n' > proof.txt");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () =>
        readFile(path.join(root, "proof.txt"), "utf8").catch(() => ""),
      )
      .toBe("PERSISTENCE-CHECK\n");
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("src");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "New file", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("notes.txt");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page
      .getByRole("option", { name: "notes.txt", exact: true })
      .dblclick();
    await page
      .getByRole("textbox", { name: "File contents" })
      .fill("A focused workspace.\n");
    await page.getByRole("button", { name: "Save file", exact: true }).click();
    await expect(page.getByText("Saved · UTF-8")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect
      .poll(() => readFile(path.join(root, "notes.txt"), "utf8"))
      .toBe("A focused workspace.\n");
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 255, 127]));
    await writeFile(
      path.join(root, "image.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page
      .getByRole("option", { name: "binary.dat", exact: true })
      .dblclick();
    await expect(page.getByLabel("File bytes")).toContainText("00 ff 7f");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("option", { name: "image.png", exact: true })
      .dblclick();
    await expect(page.getByRole("img", { name: "image.png" })).toBeVisible();
    await expect
      .poll(() =>
        page
          .getByRole("img", { name: "image.png" })
          .evaluate((image) => (image as HTMLImageElement).naturalWidth),
      )
      .toBe(1);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    const before = await page.evaluate(() => window.minimal.snapshot());
    await page.getByRole("tab", { name: "Shell 1" }).click();
    await expect(page.getByRole("tab", { name: "Shell 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    // Stub the OS clipboard source so the user's actual clipboard is untouched.
    await app.evaluate(({ clipboard }) => {
      clipboard.readText = async () =>
        "printf 'Workspace ready.\\n' > paste-proof.txt";
    });
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("Control+Shift+v");
    await expect(page.locator(".xterm-rows")).toContainText("paste-proof.txt");
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        readFile(path.join(root, "paste-proof.txt"), "utf8").catch(() => ""),
      )
      .toBe("Workspace ready.\n");
    // Right-click paste must reach the shell as a single atomic write.
    // Without bracketed-paste wrapping, multi-line clipboard text arrives
    // as keypress-by-keypress input; newlines execute as Enter and a
    // pasted command splits across multiple shell lines, leaving the
    // terminal in a broken state.
    await app.evaluate(({ clipboard }) => {
      clipboard.readText = async () => "printf 'right-click-ok\\n'";
    });
    await page.locator(".xterm-helper-textarea").focus();
    // dispatchEvent("contextmenu") reaches the renderer-side listener
    // registered on the terminal-surface testid without depending on
    // tmux/xterm mouse-handling internals.
    await page.evaluate(() => {
      const el = document.querySelector("[data-testid='terminal-surface']");
      el?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          button: 2,
        }),
      );
    });
    await expect(page.locator(".xterm-rows")).toContainText("printf");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("right-click-ok");
    await page.screenshot({ path: "docs/desktop.png" });
    await app.close();
    expect((await engine.inspect()).size).toBe(2);
    app = await launch();
    page = await app.firstWindow();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: "Shell 1" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const after = await page.evaluate(() => window.minimal.snapshot());
    expect(after.sessions[0].terminals.map((t) => t.pid)).toEqual(
      before.sessions[0].terminals.map((t) => t.pid),
    );
    await page
      .getByRole("button", { name: "Delete session", exact: true })
      .click();
    await page.getByRole("button", { name: "Stop terminals & delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Your work, still running." }),
    ).toBeVisible();
    expect((await engine.inspect()).size).toBe(0);
    expect(await readFile(path.join(root, "notes.txt"), "utf8")).toBe(
      "A focused workspace.\n",
    );
    expect(errors).toEqual([]);
  } catch (error) {
    console.error("Desktop scenario failed:", error);
    const page = app.windows()[0];
    if (page)
      await page
        .screenshot({ path: "test-results/desktop-failure.png", timeout: 3000 })
        .catch(() => {});
    throw error;
  } finally {
    await app.close().catch(() => {});
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(base, { recursive: true, force: true });
  }
});

test("command box, adding batches, individual crosses, reconnecting and launching after the last close", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-flexibility-"));
  const root = path.join(base, "project");
  await mkdir(root);
  const data = path.join(base, "data");
  const app = await electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page
      .getByRole("button", { name: "Create your first session" })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Agent workspace");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
    await page
      .getByRole("button", { name: "Create session", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Add terminals", exact: true })
      .click();
    const command = "printf 'Agent ready.\\n'; sleep 120";
    await page.getByRole("textbox", { name: /^Command/ }).fill(command);
    await page.getByRole("textbox", { name: "Terminal label" }).fill("Agent");
    await page
      .getByRole("spinbutton", { name: "Number of terminals" })
      .fill("6");
    await page
      .getByRole("checkbox", { name: "Save this command as a preset" })
      .check();
    await page.screenshot({ path: "docs/launcher.png" });
    await page
      .getByRole("button", { name: "Launch 6 terminals", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(6);
    await expect(
      page.getByRole("tab", { name: "Agent 6", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".xterm-rows")).toContainText("Agent ready.");
    await page
      .getByRole("button", { name: "Add terminals", exact: true })
      .click();
    await expect(
      page.getByRole("spinbutton", { name: "Number of terminals" }),
    ).toHaveValue("1");
    await expect(page.getByRole("textbox", { name: /^Command/ })).toHaveValue(
      command,
    );
    await page
      .getByRole("spinbutton", { name: "Number of terminals" })
      .fill("6");
    await page
      .getByRole("button", { name: "Launch 6 terminals", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(12);
    await expect(
      page.getByRole("button", { name: "Add terminals", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("tab", { name: "Agent 12", exact: true }),
    ).toBeInViewport();
    const before = await page.evaluate(() => window.minimal.snapshot());
    expect(before.presets.filter((p) => p.name === "Agent")).toHaveLength(1);
    // Closing an inactive tab keeps the selected worker and its process intact.
    await page
      .getByRole("button", { name: "Close Agent 1", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(11);
    await expect(
      page.getByRole("tab", { name: "Agent 12", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      (await engine.inspect()).has(before.sessions[0].terminals[0].id),
    ).toBe(false);
    // Closing the active last tab chooses its surviving neighbour.
    await page
      .getByRole("button", { name: "Close Agent 12", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(10);
    await expect(
      page.getByRole("tab", { name: "Agent 11", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    const survivor = before.sessions[0].terminals[10];
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    const client = () =>
      execFileSync(
        "tmux",
        [
          "-S",
          engine.socket,
          "list-clients",
          "-t",
          `=minimal_${survivor.id}`,
          "-F",
          "#{client_tty}",
        ],
        { encoding: "utf8" },
      ).trim();
    await expect.poll(client).not.toBe("");
    execFileSync("tmux", [
      "-S",
      engine.socket,
      "detach-client",
      "-t",
      client(),
    ]);
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    expect((await engine.inspect()).get(survivor.id)?.pid).toBe(survivor.pid);
    await page.getByRole("button", { name: "Hide explorer" }).click();
    await expect(
      page.getByRole("button", { name: "Refresh files" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Show explorer" }).click();
    await expect(
      page.getByRole("button", { name: "Refresh files" }),
    ).toBeVisible();
    await expect(
      page.getByRole("tab", { name: "Agent 11", exact: true }),
    ).toBeInViewport();
    await page.screenshot({ path: "docs/terminals.png" });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1000, 640),
    );
    await expect(
      page.getByRole("button", { name: "Add terminals", exact: true }),
    ).toBeInViewport();
    await expect(
      page.getByRole("tab", { name: "Agent 11", exact: true }),
    ).toBeInViewport();
    for (let count = 10; count > 0; count--) {
      await page.locator(".tab-close").last().click();
      await expect(page.getByRole("tab")).toHaveCount(count - 1);
    }
    expect((await engine.inspect()).size).toBe(0);
    await expect(
      page.getByRole("button", { name: "Add terminals", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Add terminals", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: /^Command/ })
      .fill("minimal_command_that_is_not_installed");
    await page
      .getByRole("button", { name: "Launch 1 terminal", exact: true })
      .click();
    await expect(page.locator(".terminal-caption")).toContainText("code 127");
    await page.getByRole("button", { name: "Edit & run", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /^Command/ })).toHaveValue(
      "minimal_command_that_is_not_installed",
    );
    await page
      .getByRole("textbox", { name: /^Command/ })
      .fill("printf 'Corrected command\\n'; sleep 120");
    await page
      .getByRole("button", { name: "Launch 1 terminal", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.locator(".xterm-rows")).toContainText(
      "Corrected command",
    );
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(base, { recursive: true, force: true });
  }
});

test("configurable workflows, independent sessions, rename/remove controls and rapid tab switching", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-desktop-"));
  const root = path.join(base, "project");
  const other = path.join(base, "other");
  await mkdir(root);
  await mkdir(other);
  await mkdir(path.join(root, "workers"));
  const data = path.join(base, "data");
  const app = await electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page
      .getByRole("button", { name: "Create your first session" })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("First project");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
    await page
      .getByRole("button", { name: "Create session", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Launch presets", exact: true })
      .click();
    await page.getByRole("button", { name: "Add preset" }).click();
    await page.getByRole("textbox", { name: "Preset 2 name" }).fill("Worker");
    await page
      .getByRole("textbox", { name: "Preset 2 command" })
      .fill("printf 'ready\\n' > worker-$$; sleep 120");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page
      .getByRole("button", { name: "Launch terminals", exact: true })
      .click();
    await page.getByRole("combobox", { name: "Workflow preset" }).selectOption({
      label: "Worker — printf 'ready\\n' > worker-$$; sleep 120",
    });
    await page
      .getByRole("spinbutton", { name: "Number of terminals" })
      .fill("3");
    await page
      .getByRole("textbox", { name: "Working subdirectory" })
      .fill("workers");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(3);
    // Tab records are visible while a batch is still starting. PID comparison
    // requires completed launches, not just the persisted three-item intent.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect.poll(async () => {
      const state = await page.evaluate(() => window.minimal.snapshot());
      return state.sessions[0].terminals.filter(t => t.status === "running" && t.pid !== undefined).length;
    }).toBe(3);
    const initial = await page.evaluate(() => window.minimal.snapshot());
    expect(
      initial.sessions[0].terminals.every(
        (t) => t.cwd === path.join(root, "workers"),
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Rename session", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Renamed project");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page
      .getByRole("button", { name: "Rename terminal", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Review worker");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(
      page.getByRole("tab", { name: "Review worker" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Other project");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(other);
    await page
      .getByRole("button", { name: "Create session", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("heading", { name: "Other project", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /^Renamed project .*3 terminals/ })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(3);
    for (let i = 0; i < 6; i++)
      await page
        .getByRole("tab")
        .nth(i % 3)
        .click({ delay: 0 });
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    const switched = await page.evaluate(() => window.minimal.snapshot());
    expect(switched.sessions[0].terminals.map((t) => t.pid)).toEqual(
      initial.sessions[0].terminals.map((t) => t.pid),
    );
    await page
      .getByRole("button", { name: "Remove terminal", exact: true })
      .click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    // File toolbar operations are routed through the same scoped provider.
    await page.getByRole("option", { name: "workers", exact: true }).click();
    await page.getByRole("button", { name: "Rename selected" }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("jobs");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "jobs", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "New folder", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("archive");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("option", { name: "jobs", exact: true }).click();
    await page.getByRole("button", { name: "Move selected" }).click();
    await page
      .getByRole("textbox", { name: "Destination path from session root" })
      .fill("archive/jobs");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("option", { name: "jobs", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("option", { name: "archive", exact: true }).click();
    await page.getByRole("button", { name: "Delete selected" }).click();
    await page
      .getByRole("button", { name: "Delete permanently", exact: true })
      .click();
    await expect(
      page.getByRole("option", { name: "archive", exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close().catch(() => {});
    for (const id of (await engine.inspect()).keys()) await engine.remove(id);
    await rm(base, { recursive: true, force: true });
  }
});
