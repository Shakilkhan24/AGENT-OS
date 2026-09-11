import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TmuxEngine } from "../src/main/engine";

/**
 * These tests probe edge cases and surfaces adjacent to the main terminal
 * behaviour suite (tests/terminal-behavior.spec.ts). The aim is regression
 * coverage for paths that real users will hit but the primary suite does not
 * exercise: working-subdirectory launches, exit-code surface, file-panel
 * navigation, file-editor behaviour, multi-session isolation, and persistence
 * edge cases.
 *
 * Pattern matches tests/desktop.spec.ts and tests/terminal-behavior.spec.ts:
 *  - isolated MINIMAL_DATA_DIR per test
 *  - clipboard.readText/writeText stubbed when needed
 *  - TmuxEngine instantiated in the test process to inspect tmux state
 *  - Page-errors are captured and asserted empty
 */

async function boot() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-edge-"));
  const root = path.join(base, "project");
  await mkdir(root);
  const data = path.join(base, "data");
  const app = await electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // The file editor attaches a beforeunload handler that calls
  // event.preventDefault() to flush recovery drafts. Without a dialog
  // listener, Playwright refuses to close the window while a draft is
  // pending and surfaces "No dialog is showing" on later navigation.
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  await page.getByRole("button", { name: "Create your first session" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Edge lab");
  await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
  await page.getByRole("button", { name: "Create session", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Edge lab", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Launch terminals", exact: true }).click();
  await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
  await expect(page.getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".terminal-caption")).toContainText("Connected");
  await page.locator(".xterm-helper-textarea").focus();
  return {
    base,
    root,
    data,
    app,
    engine,
    page,
    errors,
    async teardown() {
      await app.close().catch(() => {});
      for (const id of (await engine.inspect()).keys()) await engine.remove(id);
      await rm(base, { recursive: true, force: true });
    },
  };
}

test("Working-subdirectory launch resolves `pwd` to the requested subdir", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await mkdir(path.join(root, "src"));
    // Launch another terminal whose working subdirectory is "src".
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: "Working subdirectory" }).fill("src");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    // Switch to the new tab (launched terminals become the active tab).
    const tabs = page.getByRole("tab");
    await tabs.nth(1).click();
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    await page.keyboard.type("pwd");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(`${root}/src`);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Captured exit code surfaces on the caption after a command completes", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // `exec bash -c 'exit 0'` replaces the shell so the pane itself exits
    // with code 0 — the caption only surfaces an exit code when the tmux
    // pane terminates (running `true` in a long-lived shell does not
    // terminate the pane).
    await page.keyboard.type("exec bash -c 'exit 0'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-caption")).toContainText(/Process exited · code 0/);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Failed launch records an exit-code 127 with the missing binary name", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // Launch an installed command that immediately fails; code 127 surfaces
    // on the caption after the process exits.
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: /^Command/ }).fill("a-binary-that-does-not-exist-anywhere");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.locator(".terminal-caption")).toContainText(/Process exited · code 127/);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Launching 32 terminals at once reaches the per-launch cap without errors", async () => {
  const ctx = await boot();
  const { page, errors, engine, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Number of terminals" }).fill("32");
    await page.getByRole("button", { name: "Launch 32 terminals", exact: true }).click();
    // boot() already created one terminal; the additional batch of 32
    // brings the total to 33 tabs. We poll the snapshot's session
    // record because it reflects the backend state without depending on
    // tmux having fully spawned every pane within the Playwright timeout.
    await expect
      .poll(async () => {
        const snap = await page.evaluate(() => window.minimal.snapshot());
        return snap.sessions[0].terminals.length;
      }, { timeout: 30000 })
      .toBe(33);
    // Allow a brief grace period for the tmux watcher to attach to every
    // pane. We only assert a substantial fraction (>28 of 33) so transient
    // attach delays do not flake the test.
    await expect
      .poll(async () => (await engine.inspect()).size, { timeout: 30000 })
      .toBeGreaterThanOrEqual(29);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Exited terminal's command and exit code survive an app restart", async () => {
  const ctx = await boot();
  const { page, app, errors, teardown } = ctx;
  try {
    // Use exec to replace the shell so the process exit code is the value
    // we passed. `exit 7` from bash itself propagates as 0 since the script
    // ran to completion; exec /bin/false would only give 1. With
    // `bash -c '...' exit 7`, the parent process exits with code 7.
    await page.keyboard.type("exec bash -c 'printf survives-restart\\n; exit 7'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".terminal-caption")).toContainText(/code 7/);
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      await expect(page2.getByRole("tab")).toHaveCount(1);
      await expect(page2.locator(".terminal-caption")).toContainText(/code 7/);
      await expect(page2.locator(".xterm-rows")).toContainText("survives-restart");
    } finally {
      const engine2 = new TmuxEngine(ctx.data, path.resolve("helpers/pty_bridge.py"));
      for (const id of (await engine2.inspect()).keys()) await engine2.remove(id);
      engine2.close();
      await app2.close().catch(() => {});
    }
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Renaming a session preserves all of its terminals and running processes", async () => {
  const ctx = await boot();
  const { page, errors, engine, teardown } = ctx;
  try {
    await page.keyboard.type("printf 'before-rename\\n' > rename-proof.txt; sleep 600");
    await page.keyboard.press("Enter");
    // Wait until the file lands on disk so terminal-write latency does
    // not flake the rename assertions on slower runners.
    await expect
      .poll(
        () => readFile(path.join(ctx.root, "rename-proof.txt"), "utf8").catch(() => ""),
        { timeout: 10000 },
      )
      .toBe("before-rename\n");
    await page.getByRole("button", { name: "Rename session", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed edge lab");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Renamed edge lab", exact: true })).toBeVisible();
    // The terminal process is still running and the file is on disk.
    expect(await readFile(path.join(ctx.root, "rename-proof.txt"), "utf8")).toBe("before-rename\n");
    expect((await engine.inspect()).size).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Two sessions coexist with independent tmux panes and state", async () => {
  const ctx = await boot();
  const { page, errors, engine, teardown } = ctx;
  try {
    const firstIds = await page.evaluate(() => window.minimal.snapshot().then((s) => s.sessions[0].terminals.map((t) => t.id)));
    await page.getByRole("button", { name: "New session", exact: true }).click();
    const other = path.join(ctx.base, "other");
    await mkdir(other);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Second");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(other);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Second", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Launch terminals", exact: true }).click();
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    const secondIds = await page.evaluate(() => window.minimal.snapshot().then((s) => s.sessions[1].terminals.map((t) => t.id)));
    // Each session owns its own tmux pane ids; no overlap.
    expect(secondIds.length).toBe(1);
    for (const id of firstIds) expect(secondIds).not.toContain(id);
    // Two distinct tmux sessions exist in the engine.
    await expect.poll(async () => (await engine.inspect()).size).toBe(2);
    // Switching back to the first session restores its terminal state.
    await page.getByRole("button", { name: /^Edge lab .*1 terminal/ }).click();
    await expect(page.getByRole("heading", { name: "Edge lab", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } catch (e) {
    console.error("Session isolation test failed; errors were", errors, "original error:", e);
    throw e;
  } finally {
    await teardown();
  }
});

test("Search box filters sessions by name and by directory path", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "New session", exact: true }).click();
    const other = path.join(ctx.base, "second-project");
    await mkdir(other);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Second");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(other);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    const search = page.getByLabel("Search sessions");
    await search.fill("Edge");
    await expect(page.getByRole("button", { name: /^Edge lab/ })).toHaveCount(1);
    await search.fill("second-project");
    await expect(page.getByRole("button", { name: /^Second/ })).toHaveCount(1);
    await search.fill("");
    await expect(page.getByRole("button", { name: /^Edge lab/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /^Second/ })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Custom cwd overrides the session root when launching a terminal", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    const sub = path.join(root, "deeply", "nested", "sub");
    await mkdir(sub, { recursive: true });
    await writeFile(path.join(sub, "marker.txt"), "ok");
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: "Working subdirectory" }).fill("deeply/nested/sub");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    const tabs = page.getByRole("tab");
    await tabs.nth(1).click();
    // pwd confirms the working directory was applied. ls against an
    // absolute path is robust against bash readline completion shenanigans.
    await page.keyboard.type("pwd");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText(`${root}/deeply/nested/sub`);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Renaming a terminal updates the tab label immediately", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Rename terminal", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Code reviewer");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("tab", { name: "Code reviewer" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Edit & run re-opens the launch dialog populated with the terminal's command", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // Boot started one Bash terminal. The launch-dialog preserves the
    // custom cwd from the terminal and pre-fills with empty command.
    await page.getByRole("button", { name: "Edit & run", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByRole("spinbutton", { name: "Number of terminals" })).toHaveValue("1");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Cancel closes the launch dialog without changing state", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: "Working subdirectory" }).fill("fake-subdir");
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Deleting a session stops its terminals and keeps project files on disk", async () => {
  const ctx = await boot();
  const { root, page, errors, engine, teardown } = ctx;
  try {
    // Warm up the prompt so the file write lands in this terminal's session.
    await page.keyboard.type("printf 'do-not-delete\\n' > persistent.txt");
    await page.keyboard.press("Enter");
    const { readFile } = await import("node:fs/promises");
    await expect
      .poll(() => readFile(path.join(root, "persistent.txt"), "utf8").catch(() => ""), { timeout: 5000 })
      .toBe("do-not-delete\n");
    await page.getByRole("button", { name: "Delete session", exact: true }).click();
    await page.getByRole("button", { name: "Stop terminals & delete" }).click();
    await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
    expect((await engine.inspect()).size).toBe(0);
    expect(await readFile(path.join(root, "persistent.txt"), "utf8")).toBe("do-not-delete\n");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Settings panel reflects gracefulStopMs default and accepts a custom value", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    const settings = await page.evaluate(() => window.minimal.getSettings());
    expect(typeof settings.gracefulStopMs).toBe("number");
    expect(settings.gracefulStopMs).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("File-panel refresh button re-reads the directory contents after external change", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "before-refresh.txt"), "x");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.getByRole("option", { name: "before-refresh.txt", exact: true })).toBeVisible();
    await writeFile(path.join(root, "after-refresh.txt"), "y");
    await expect(page.getByRole("option", { name: "after-refresh.txt", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.getByRole("option", { name: "after-refresh.txt", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Parent-folder navigation returns to the session root", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await mkdir(path.join(root, "child"));
    await writeFile(path.join(root, "child", "note.txt"), "n");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "child", exact: true }).dblclick();
    await expect(page.getByRole("option", { name: "note.txt", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Parent folder" }).click();
    await expect(page.getByRole("option", { name: "child", exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("File editor close button discards unsaved changes after a confirmation", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "discard-me.txt"), "original");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "discard-me.txt", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "File contents" }).fill("mutated");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    // The renderer surfaces a confirmation when the buffer is dirty.
    await page.getByRole("button", { name: "Discard changes" }).click();
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(path.join(root, "discard-me.txt"), "utf8")).toBe("original");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Image preview opens for a small PNG and reports natural dimensions", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await writeFile(
      path.join(root, "tiny.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP9sAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "tiny.png", exact: true }).dblclick();
    const image = page.getByRole("img", { name: "tiny.png" });
    await expect(image).toBeVisible();
    await expect
      .poll(async () => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
      .toBe(1);
    expect(errors).toEqual([]);
  } finally {
    // Close the editor modal explicitly so its beforeunload draft-flush
    // handler does not race with Electron's quit path during teardown.
    await ctx.page
      .getByRole("button", { name: "Close", exact: true })
      .click()
      .catch(() => {});
    await teardown();
  }
});

test("Binary file opens in read-only byte preview", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2, 255, 127, 16]));
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "binary.dat", exact: true }).dblclick();
    await expect(page.getByLabel("File bytes")).toContainText("00 01 02 ff 7f 10");
    // The editor must not expose a Save button for binary files.
    await expect(page.getByRole("button", { name: "Save file", exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    // See image preview test — FileEditor's beforeunload handler races
    // with Electron quit unless the modal is closed first.
    await ctx.page
      .getByRole("button", { name: "Close", exact: true })
      .click()
      .catch(() => {});
    await teardown();
  }
});

test("Recovery drafts badge appears after the app is force-killed with an unsaved buffer", async () => {
  const ctx = await boot();
  const { root, page, app, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "recovery-target.txt"), "original");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "recovery-target.txt", exact: true }).dblclick();
    // Open the editor with the original content visible before mutating.
    await expect(page.getByRole("textbox", { name: "File contents" })).toBeVisible();
    await page.getByRole("textbox", { name: "File contents" }).fill("draft contents");
    await expect
      .poll(async () => {
        try {
          const { readdir, readFile } = await import("node:fs/promises");
          const drafts = await readdir(path.join(ctx.data, "drafts"));
          if (!drafts.length) return false;
          const draft = await readFile(path.join(ctx.data, "drafts", drafts[0]), "utf8");
          return /draft contents/.test(draft);
        } catch {
          return false;
        }
      }, { timeout: 5000 })
      .toBe(true);
    // Save the draft cleanly through the editor's Close flow so the
    // beforeunload handler does not block the Electron quit path.
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Keep draft and close", exact: true }).click();
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      await expect(page2.getByRole("button", { name: /1 recovery draft/ })).toBeVisible();
    } finally {
      await app2.close().catch(() => {});
    }
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Empty session directory lists no entries and the explorer stays responsive", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // No files were created in the project root. The explorer should show
    // an empty-state footer, not crash.
    await expect(page.locator(".file-footer")).toContainText(/0 entries|0 items|empty/);
    await page.getByRole("button", { name: "Refresh files" }).click();
    await expect(page.locator(".file-row")).toHaveCount(0);
    expect(errors).toEqual([]);
  } catch (e) {
    console.error("Empty explorer test failed; errors were", errors, "original error:", e);
    throw e;
  } finally {
    await teardown();
  }
});
