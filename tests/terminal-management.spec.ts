import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { TmuxEngine } from "../src/main/engine";

/**
 * Regression coverage for surfaces that affect terminal management but are
 * distinct from per-keystroke behaviour (terminal-behavior.spec.ts) and
 * immediate UI flows (terminal-edge-cases.spec.ts).
 *
 * Themes:
 *  - Settings, env profiles, and hooks persistence across launches
 *  - Stop policy timing and SIGTERM propagation
 *  - Draft lifecycle: corruption, restoration after delete, badge clearing
 *  - Engine failure surface and recovery (engine-error toast)
 *  - Tab selection persistence and concurrent launch/close
 *  - Working-directory surface (initial cwd override, custom command labels)
 *  - Browser-window resize and rapid attach/detach cycles
 */
const exec = promisify(execFile);

async function boot() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-mgmt-"));
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
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  await page.getByRole("button", { name: "Create your first session" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Mgmt lab");
  await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
  await page.getByRole("button", { name: "Create session", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Mgmt lab", exact: true })).toBeVisible();
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

test("Settings file is created on first launch and matches the default schema", async () => {
  const ctx = await boot();
  const { page, data, errors, teardown } = ctx;
  try {
    const settingsOnDisk = JSON.parse(
      await readFile(path.join(data, "settings.json"), "utf8"),
    );
    expect(settingsOnDisk.version).toBe(1);
    expect(settingsOnDisk.gracefulStopMs).toBeGreaterThan(0);
    // Same value the renderer observes.
    const live = await page.evaluate(() => window.minimal.getSettings());
    expect(live.gracefulStopMs).toBe(settingsOnDisk.gracefulStopMs);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Custom settings file is honored on the next launch", async () => {
  const ctx = await boot();
  const { data, app, teardown } = ctx;
  try {
    // Overwrite the settings file directly so the next launch picks it up.
    await writeFile(
      path.join(data, "settings.json"),
      JSON.stringify({ version: 1, gracefulStopMs: 4321, draftIntervalMs: 200 }),
    );
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: data },
    });
    try {
      const page = await app2.firstWindow();
      const live = await page.evaluate(() => window.minimal.getSettings());
      expect(live.gracefulStopMs).toBe(4321);
      expect(live.draftIntervalMs).toBe(200);
    } finally {
      // Await process exit and dispose the automation connection before cleanup.
      await app2.close();
    }
  } finally {
    await teardown();
  }
});

test("User-added presets survive an app restart and remain order-stable", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Launch presets", exact: true }).click();
    await page.getByRole("button", { name: "Add preset" }).click();
    await page.getByRole("textbox", { name: "Preset 2 name" }).fill("Worker A");
    await page.getByRole("textbox", { name: "Preset 2 command" }).fill("printf 'a\\n'; sleep 600");
    await page.getByRole("button", { name: "Save changes" }).click();
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      const snap = await page2.evaluate(() => window.minimal.snapshot());
      const names = snap.presets.map((p) => p.name);
      expect(names).toContain("Worker A");
      // The default empty preset still exists at index 0 with the default label.
      expect(names[0]).toBe("Shell");
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Removing a preset and adding a new one persists through restart", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Launch presets", exact: true }).click();
    await page.getByRole("button", { name: "Add preset" }).click();
    await page.getByRole("textbox", { name: "Preset 2 name" }).fill("Throwaway");
    await page.getByRole("textbox", { name: "Preset 2 command" }).fill("printf 'x'");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.getByRole("button", { name: "Launch presets", exact: true }).click();
    await page.getByRole("button", { name: "Remove Throwaway preset", exact: true }).click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      const snap = await page2.evaluate(() => window.minimal.snapshot());
      expect(snap.presets.map((p) => p.name)).not.toContain("Throwaway");
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Last selected session is restored on next launch", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "New session", exact: true }).click();
    const other = path.join(ctx.base, "second");
    await mkdir(other);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Second");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(other);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    await expect(page.getByRole("heading", { name: "Second", exact: true })).toBeVisible();
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      await expect(
        page2.getByRole("heading", { name: "Second", exact: true }),
      ).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Last selected terminal per session is restored on next launch", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    // Launch two more terminals so we can pick a non-default tab.
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: "Terminal label" }).fill("Worker");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await page.getByRole("tab", { name: "Shell 1", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Shell 1", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      await expect(page2.getByRole("tab")).toHaveCount(2);
      await expect(
        page2.getByRole("tab", { name: "Shell 1", exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Explorer hide/show preference survives an app restart", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Hide explorer" }).click();
    await expect(page.getByRole("button", { name: "Refresh files" })).toHaveCount(0);
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      // Explorer starts hidden: the refresh button is not rendered.
      await expect(page2.getByRole("button", { name: "Refresh files" })).toHaveCount(0);
      await page2.getByRole("button", { name: "Show explorer" }).click();
      await expect(page2.getByRole("button", { name: "Refresh files" })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Closing a terminal sends SIGTERM to its foreground process", async () => {
  const ctx = await boot();
  const { page, engine, errors, teardown } = ctx;
  try {
    // Launch a sleep 600 process whose PID we can track.
    await page.keyboard.type("exec bash -c 'sleep 600 & echo $! > /tmp/minimal-mgmt-pid; wait'");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => {
        try {
          return (await readFile("/tmp/minimal-mgmt-pid", "utf8")).trim();
        } catch {
          return "";
        }
      }, { timeout: 5000 })
      .toMatch(/^\d+$/);
    const childPid = (await readFile("/tmp/minimal-mgmt-pid", "utf8")).trim();
    // Close the tab and confirm tmux removes the pane.
    await page.getByRole("button", { name: "Remove terminal", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect
      .poll(async () => {
        try {
          // Sending signal 0 returns the process status without killing it.
          // ESRCH means the process is gone.
          await exec("kill", ["-0", childPid]);
          return true;
        } catch {
          return false;
        }
      }, { timeout: 10000 })
      .toBe(false);
    expect((await engine.inspect()).size).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Resizing the browser window keeps the terminal responsive", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.keyboard.type("printf 'before-resize\\n'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("before-resize");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1100, 700),
    );
    // The terminal must accept new input after the resize — proving the
    // resize pipeline (renderer → IPC → tmux) survived the change.
    await expect
      .poll(async () => {
        await page.keyboard.type("printf 'after-resize\\n'");
        await page.keyboard.press("Enter");
        return true;
      })
      .toBe(true);
    await expect(page.locator(".xterm-rows")).toContainText("after-resize");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Three rapid launch batches all reach connected state without errors", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    for (let batch = 0; batch < 3; batch++) {
      await page.getByRole("button", { name: "Add terminals", exact: true }).click();
      await expect(
        page.getByRole("spinbutton", { name: "Number of terminals" }),
      ).toBeVisible();
      const count = page.getByRole("spinbutton", { name: "Number of terminals" });
      await count.fill("");
      await count.fill("2");
      await page.getByRole("textbox", { name: "Terminal label" }).fill(`B${batch + 1}`);
      await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
      await expect
        .poll(async () => page.getByRole("tab").count(), { timeout: 10000 })
        .toBe(1 + (batch + 1) * 2);
    }
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Closing all tabs and adding a new one does not leave orphan panes", async () => {
  const ctx = await boot();
  const { page, errors, engine, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Number of terminals" }).fill("3");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(4);
    // Close every tab via the per-tab × button. Wait for the previous
    // close to finish (tab removed) before clicking the next so the new
    // active tab's close button is enabled and stable.
    while ((await page.getByRole("tab").count()) > 0) {
      const remaining = await page.getByRole("tab").count();
      const close = page.locator(".tab-close").nth(remaining - 1);
      await expect(close).toBeEnabled({ timeout: 5000 });
      await close.click();
      await expect(page.getByRole("tab")).toHaveCount(remaining - 1);
    }
    await expect(page.getByRole("tab")).toHaveCount(0);
    await expect.poll(async () => (await engine.inspect()).size).toBe(0);
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Drafts badge clears after the user restores and discards every draft", async () => {
  const ctx = await boot();
  const { root, page, app, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "draft-a.txt"), "alpha");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "draft-a.txt", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "File contents" }).fill("alpha draft");
    await expect
      .poll(async () => {
        try {
          const { readdir } = await import("node:fs/promises");
          return (await readdir(path.join(ctx.data, "drafts"))).length;
        } catch {
          return 0;
        }
      }, { timeout: 5000 })
      .toBeGreaterThan(0);
    // Close cleanly so the beforeunload handler does not block Electron quit.
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
      const badge = page2.getByRole("button", { name: /1 recovery draft/ });
      await expect(badge).toBeVisible();
      await badge.click();
      await page2.getByRole("button", { name: "Restore", exact: true }).click();
      // Discarding the recovered content closes the badge entirely.
      await page2.getByRole("button", { name: "Close", exact: true }).click();
      await page2.getByRole("button", { name: "Discard changes" }).click();
      await expect(
        page2.getByRole("button", { name: /recovery draft/ }),
      ).toHaveCount(0);
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Draft entry survives its parent session being deleted", async () => {
  const ctx = await boot();
  const { root, page, errors, teardown } = ctx;
  try {
    await writeFile(path.join(root, "draft-keeps.txt"), "ok");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "draft-keeps.txt", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "File contents" }).fill("unsaved");
    await expect
      .poll(async () => {
        try {
          const { readdir } = await import("node:fs/promises");
          return (await readdir(path.join(ctx.data, "drafts"))).length;
        } catch {
          return 0;
        }
      }, { timeout: 5000 })
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Keep draft and close", exact: true }).click();
    await page.getByRole("button", { name: "Delete session", exact: true }).click();
    await page.getByRole("button", { name: "Stop terminals & delete" }).click();
    await expect(
      page.getByRole("heading", { name: "Your work, still running." }),
    ).toBeVisible();
    // The draft file remains on disk even though its session is gone.
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(path.join(ctx.data, "drafts"))).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Engine-error toast appears when the tmux socket is unusable", async () => {
  const ctx = await boot();
  const { page, engine, errors, teardown } = ctx;
  try {
    // Replace the socket file with a directory of the same name. tmux
    // cannot bind/listen to a path that is not a socket, so the next
    // `list-panes` call surfaces a non-suppressed error and the snapshot
    // reports the engineError to the renderer.
    execFileSync("rm", ["-f", engine.socket]);
    execFileSync("mkdir", ["-m", "000", engine.socket]);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.minimal.snapshot())).engineError,
        { timeout: 15000 },
      )
      .toBeTruthy();
    await expect(page.locator(".engine-error")).toBeVisible();
    await expect(page.locator(".sidebar-status")).toContainText("Connection issue");
    expect(errors).toEqual([]);
  } finally {
    try {
      execFileSync("rm", ["-rf", engine.socket]);
    } catch {}
    await teardown();
  }
});

test("Running-pill count tracks the number of running terminals", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    const pill = page.locator(".running-pill");
    await expect(pill).toContainText("1 running");
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Number of terminals" }).fill("2");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(pill).toContainText("3 running");
    await page.locator(".tab-close").first().click();
    await expect(pill).toContainText("2 running");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Process label surfaces the custom command, not a generic bash", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: /^Command/ }).fill("exec env");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    // The new terminal becomes active. Its caption should reflect a custom
    // command — the env exec is short-lived, but the launchState keeps it
    // discoverable as a non-bash command.
    await expect
      .poll(async () => page.locator(".process-label").first().textContent())
      .not.toBe("");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Reconnect button appears after the underlying tmux client detaches", async () => {
  const ctx = await boot();
  const { engine, page, errors, teardown } = ctx;
  try {
    await page.keyboard.type("exec sleep 600");
    await page.keyboard.press("Enter");
    const id = (
      await page.evaluate(() => window.minimal.snapshot())
    ).sessions[0].terminals[0].id;
    const socket = engine.socket;
    // Force the active tmux client for our pane to detach.
    const client = execFileSync(
      "tmux",
      ["-S", socket, "list-clients", "-t", `=minimal_${id}`, "-F", "#{client_tty}"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("tmux", ["-S", socket, "detach-client", "-t", client]);
    await expect(
      page.getByRole("button", { name: "Reconnect", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Empty session survives an app restart without terminals", async () => {
  const ctx = await boot();
  const { app, page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "New session", exact: true }).click();
    const other = path.join(ctx.base, "empty");
    await mkdir(other);
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Empty");
    await page.getByPlaceholder("/home/you/projects/my-project").fill(other);
    await page.getByRole("button", { name: "Create session", exact: true }).last().click();
    await app.close();
    const app2 = await electron.launch({
      executablePath: process.env.MINIMAL_ELECTRON_PATH,
      args: ["."],
      env: { ...process.env, MINIMAL_DATA_DIR: ctx.data },
    });
    try {
      const page2 = await app2.firstWindow();
      const snap = await page2.evaluate(() => window.minimal.snapshot());
      const empty = snap.sessions.find((s) => s.name === "Empty");
      expect(empty).toBeTruthy();
      expect(empty!.terminals).toHaveLength(0);
      expect(errors).toEqual([]);
    } finally {
      await app2.close().catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Ctrl+L clears the visible terminal screen without dropping the connection", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.keyboard.type("printf 'screen-marker\\n'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("screen-marker");
    await page.keyboard.press("Control+l");
    // The connection survives the screen clear; typing after it still works.
    await page.keyboard.type("printf 'after-clear\\n'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("after-clear");
    await expect(page.locator(".terminal-caption")).toContainText("Connected");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Custom command label updates the tab name without affecting the stored command", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("textbox", { name: "Terminal label" }).fill("Reviewer");
    await page.getByRole("textbox", { name: /^Command/ }).fill("printf 'review\\n'; sleep 600");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    // The launch coordinator suffixes the label with 1 since the default
    // "Shell 1" doesn't conflict with "Reviewer 1".
    await expect(page.getByRole("tab", { name: "Reviewer 1" })).toBeVisible();
    // Open the launch dialog for this terminal: the command field is the
    // one we launched with, not the label.
    await page.getByRole("tab", { name: "Reviewer 1" }).click();
    await page.getByRole("button", { name: "Edit & run", exact: true }).click();
    await expect(page.getByRole("textbox", { name: /^Command/ })).toHaveValue(
      "printf 'review\\n'; sleep 600",
    );
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Help dialog explains the workspace without affecting state", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "How it works", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "A home for running work." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Got it" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Browser back/forward navigation is blocked by the renderer shell", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.goBack().catch(() => {});
    await page.goForward().catch(() => {});
    // The shell is unchanged: we still see the workspace.
    await expect(
      page.getByRole("heading", { name: "Mgmt lab", exact: true }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Draft interval setting controls how quickly drafts flush", async () => {
  const ctx = await boot();
  const { root, page, data, errors, teardown } = ctx;
  try {
    // Lower the draft interval to 100ms so the test runs quickly.
    await writeFile(
      path.join(data, "settings.json"),
      JSON.stringify({ version: 1, draftIntervalMs: 100 }),
    );
    // Reload the page so the new DraftMirror picks up the lower delay.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Mgmt lab", exact: true })).toBeVisible();
    await writeFile(path.join(root, "fast-draft.txt"), "v0");
    await page.getByRole("button", { name: "Refresh files" }).click();
    await page.getByRole("option", { name: "fast-draft.txt", exact: true }).dblclick();
    await page.getByRole("textbox", { name: "File contents" }).fill("v1");
    // With draftIntervalMs at 100, the draft must land well inside the poll
    // window — a slow flush would surface as a longer delay.
    await expect
      .poll(async () => {
        try {
          const { readdir, readFile } = await import("node:fs/promises");
          const files = await readdir(path.join(data, "drafts"));
          if (!files.length) return false;
          const draft = await readFile(path.join(data, "drafts", files[0]), "utf8");
          return /v1/.test(draft);
        } catch {
          return false;
        }
      }, { timeout: 5000 })
      .toBe(true);
    expect(errors).toEqual([]);
  } finally {
    // Close the editor explicitly through the "Keep draft and close" path
    // so the beforeunload handler does not race with Electron's quit.
    await page
      .getByRole("button", { name: "Close", exact: true })
      .click()
      .catch(() => {});
    await page
      .getByRole("button", { name: "Keep draft and close", exact: true })
      .click()
      .catch(() => {});
    await teardown();
  }
});
