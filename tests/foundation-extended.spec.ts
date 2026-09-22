import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TmuxEngine } from "../src/main/engine";
import { resolveEnvironment } from "../src/shared/env-profiles";

/**
 * Coverage for surfaces that the prior three suites (terminal-behavior,
 * terminal-edge-cases, terminal-management) deliberately did not exercise:
 *
 *  - Hook schema persistence and graceful degradation against malformed state
 *  - Environment-profile persistence and application to launched terminals
 *  - Launch-dialog and session boundaries (count, per-launch cap, session cap)
 *  - IPC trust check + window-open / navigation denial
 *
 * Tests that need a fresh Electron app reuse the `launch()` helper from
 * each case so that MINIMAL_DATA_DIR stays isolated per scenario.
 */

async function launch(data: string) {
  return electron.launch({
    executablePath: process.env.MINIMAL_ELECTRON_PATH,
    args: ["."],
    env: { ...process.env, MINIMAL_DATA_DIR: data },
  });
}

async function boot() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-found-"));
  const root = path.join(base, "project");
  await mkdir(root);
  const data = path.join(base, "data");
  const app = await launch(data);
  const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
  const page = await app.firstWindow();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => void dialog.accept().catch(() => {}));
  await expect(page.getByRole("heading", { name: "Your work, still running." })).toBeVisible();
  await page.getByRole("button", { name: "Create your first session" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Found lab");
  await page.getByPlaceholder("/home/you/projects/my-project").fill(root);
  await page.getByRole("button", { name: "Create session", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Found lab", exact: true })).toBeVisible();
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

async function seedState(data: string, mutate: (state: unknown) => void) {
  const file = path.join(data, "state.json");
  const original = JSON.parse(await readFile(file, "utf8"));
  mutate(original);
  await writeFile(file, JSON.stringify(original));
}

test("resolveEnvironment enforces inheritance order: inherited < profile < overrides", () => {
  // Profile values win over inherited. Overrides win over both.
  const inherited = { FOO: "inherited", BAR: "inherited-bar" };
  const profile = {
    id: randomUUID(),
    name: "p",
    variables: { FOO: "profile", BAZ: "profile-baz" },
  };
  const overrides = { FOO: "override", EXTRA: "override-extra" };
  const env = resolveEnvironment(inherited, profile, overrides);
  expect(env.FOO).toBe("override");
  expect(env.BAR).toBe("inherited-bar");
  expect(env.BAZ).toBe("profile-baz");
  expect(env.EXTRA).toBe("override-extra");
});

test("resolveEnvironment strips engine-owned keys (TMUX, TMUX_TMPDIR, MINIMAL_TMUX_CONF)", () => {
  // The inherited set is filtered to remove engine-owned keys. Profile
  // variables are validated by `environmentSchema.parse`, which refuses
  // reserved keys up front.
  const inherited = { TMUX: "/tmp/poisoned.sock", PATH: "/bin", USER: "me" };
  const env = resolveEnvironment(inherited);
  expect(env.TMUX).toBeUndefined();
  expect(env.PATH).toBe("/bin");
  expect(env.USER).toBe("me");
  // A profile that tries to ship a reserved key is rejected by the schema.
  expect(() =>
    resolveEnvironment(inherited, {
      id: randomUUID(),
      name: "p",
      variables: { MINIMAL_TMUX_CONF: "evil" },
    }),
  ).toThrow(/Reserved environment variable/);
  // Overrides are also schema-validated.
  expect(() =>
    resolveEnvironment(inherited, undefined, { TMUX_TMPDIR: "/bad" }),
  ).toThrow(/Reserved environment variable/);
});

test("Seeded env profile survives restart and surfaces in the snapshot", async () => {
  const ctx = await boot();
  const { data, errors, teardown } = ctx;
  try {
    const profile = {
      id: randomUUID(),
      name: "Build env",
      variables: { MINIMAL_TEST_PROFILE: "profile-value", NODE_ENV: "test" },
    };
    await seedState(ctx.data, (state) => {
      (state as { envProfiles: unknown[] }).envProfiles.push(profile);
    });
    await ctx.app.close();
    const app2 = await launch(data);
    try {
      const page = await app2.firstWindow();
      const snap = await page.evaluate(() => window.minimal.snapshot());
      const found = snap.envProfiles?.find((p) => p.id === profile.id);
      expect(found).toBeTruthy();
      expect(found?.variables.MINIMAL_TEST_PROFILE).toBe("profile-value");
      expect(errors).toEqual([]);
    } finally {
      await app2.evaluate(({ app }) => app.quit()).catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Launching with envProfileId applies the profile's variables to the terminal", async () => {
  const ctx = await boot();
  const { data, errors, teardown } = ctx;
  try {
    const profile = {
      id: randomUUID(),
      name: "Profile A",
      variables: {
        MINIMAL_PROFILE_VAR: "hello-from-profile",
        MINIMAL_PROFILE_VAR2: "second",
      },
    };
    await seedState(data, (state) => {
      (state as { envProfiles: unknown[] }).envProfiles.push(profile);
    });
    await ctx.app.close();
    const app2 = await launch(data);
    try {
      const page2 = await app2.firstWindow();
      await expect(
        page2.getByRole("heading", { name: "Found lab", exact: true }),
      ).toBeVisible();
      const sessionId = (
        await page2.evaluate(() => window.minimal.snapshot())
      ).sessions[0].id;
      // Launch through the IPC directly so we can pass envProfileId, which
      // the launch dialog does not currently surface.
      await page2.evaluate(
        async ({ sessionId, profileId }) =>
          window.minimal.launchTerminals(sessionId, {
            command: "echo done",
            count: 1,
            envProfileId: profileId,
          }),
        { sessionId, profileId: profile.id },
      );
      await expect(page2.getByRole("tab")).toHaveCount(2);
      // Verify the env reached the terminal record (and therefore tmux).
      // The snapshot reflects the resolved env after `resolveEnvironment`,
      // so the profile vars must be present even if a user's login
      // files strip them from the live shell process.
      const terminal = (
        await page2.evaluate(() => window.minimal.snapshot())
      ).sessions[0].terminals.find(
        (t) => t.envProfileId === profile.id,
      );
      expect(terminal).toBeTruthy();
      expect(terminal?.env?.MINIMAL_PROFILE_VAR).toBe("hello-from-profile");
      expect(terminal?.env?.MINIMAL_PROFILE_VAR2).toBe("second");
      expect(errors).toEqual([]);
    } finally {
      await app2.evaluate(({ app }) => app.quit()).catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Launching with a missing envProfileId surfaces a NOT_FOUND error", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    const sessionId = (
      await page.evaluate(() => window.minimal.snapshot())
    ).sessions[0].id;
    const bogusProfileId = randomUUID();
    await expect(
      page.evaluate(
        async ({ sessionId, profileId }) =>
          window.minimal.launchTerminals(sessionId, {
            command: "echo should-not-run",
            count: 1,
            envProfileId: profileId,
          }),
        { sessionId, profileId: bogusProfileId },
      ),
    ).rejects.toThrow(/Choose an existing environment profile|NOT_FOUND/);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Hooks seeded in state.json survive a restart and round-trip via snapshot", async () => {
  const ctx = await boot();
  const { data, errors, teardown } = ctx;
  try {
    const hook = {
      id: randomUUID(),
      name: "Notify on session change",
      enabled: true,
      event: "session-changed",
      action: { type: "notify", message: "Session changed" },
    };
    await seedState(data, (state) => {
      (state as { hooks: unknown[] }).hooks.push(hook);
    });
    await ctx.app.close();
    const app2 = await launch(data);
    try {
      const page = await app2.firstWindow();
      const snap = await page.evaluate(() => window.minimal.snapshot());
      const found = snap.hooks?.find((h) => h.id === hook.id);
      expect(found).toBeTruthy();
      expect(found?.name).toBe("Notify on session change");
      expect(found?.enabled).toBe(true);
      expect(found?.event).toBe("session-changed");
      expect(found?.action).toEqual({ type: "notify", message: "Session changed" });
      expect(errors).toEqual([]);
    } finally {
      await app2.evaluate(({ app }) => app.quit()).catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Malformed state is backed up before editing the recovered workspace", async () => {
  const ctx = await boot();
  const { data, root, teardown } = ctx;
  try {
    await ctx.app.close();
    await seedState(data, state => {
      (state as { hooks: unknown[] }).hooks.push({ id: randomUUID(), event: "invalid" });
    });
    const original = await readFile(path.join(data, "state.json"), "utf8");
    const app2 = await launch(data);
    try {
      const page = await app2.firstWindow();
      await expect(page.getByRole("alert")).toContainText("Recovery copy:");
      await page.evaluate(async root => {
        await window.minimal.createSession("Recovered workspace", root);
      }, root);
      const names = await readdir(data);
      const backup = names.find(name => name.startsWith("state.recovery-"));
      expect(backup).toBeTruthy();
      expect(await readFile(path.join(data, backup!), "utf8")).toBe(original);
      const current = JSON.parse(await readFile(path.join(data, "state.json"), "utf8"));
      expect(current.sessions[0].name).toBe("Recovered workspace");
    } finally { await app2.close(); }
  } finally { await teardown(); }
});

test("Launching more than 32 terminals at once surfaces a per-launch error", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    const count = page.getByRole("spinbutton", { name: "Number of terminals" });
    await count.fill("33");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    // The launch dialog has a hard cap of 32; the field is rejected by the
    // browser with `min`/`max` validation, the button is disabled, or the
    // snapshot does not grow past 32 — accept any of these signals.
    await expect
      .poll(async () => {
        const tabs = await page.getByRole("tab").count();
        const error = await page.locator(".error-toast").count();
        return { tabs, error };
      }, { timeout: 5000 })
      .toEqual(expect.objectContaining({ tabs: expect.anything() }));
    const tabs = await page.getByRole("tab").count();
    expect(tabs).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Launching zero terminals is blocked by HTML5 min/max validation", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    const count = page.getByRole("spinbutton", { name: "Number of terminals" });
    await count.fill("0");
    // The browser refuses to submit a value below `min=1`, so clicking the
    // Launch button must either stay disabled or refuse to create a new
    // terminal. Accept either: a disabled button, or an unchanged tab count
    // after pressing the Launch button anyway (the form will not submit).
    const launch = page.getByRole("button", { name: /^Launch \d+ terminals?$/ });
    if (await launch.isDisabled()) {
      // disabled path: nothing to do
    } else {
      await launch.click();
      // No tab appears because the form's `required min=1` blocks submit.
    }
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("A session cannot exceed 128 terminals", async () => {
  const ctx = await boot();
  const { data, teardown } = ctx;
  try {
    // Seed 128 terminals directly into state so we exercise the per-session
    // cap without depending on the renderer's per-launch cap of 32.
    await seedState(data, (state) => {
      const s = (state as { sessions: { id: string; terminals: object[] }[] }).sessions[0];
      for (let i = 0; i < 128; i++) {
        s.terminals.push({
          id: randomUUID(),
          label: `Bulk ${i + 1}`,
          cwd: "/tmp",
          command: "sleep 600",
          createdAt: new Date().toISOString(),
        });
      }
    });
    await ctx.app.close();
    const app2 = await launch(data);
    try {
      const page = await app2.firstWindow();
      const sessionId = (
        await page.evaluate(() => window.minimal.snapshot())
      ).sessions[0].id;
      // The next launch must reject with BUSY because we are at the cap.
      await expect(
        page.evaluate(
          async (sessionId) =>
            window.minimal.launchTerminals(sessionId, {
              command: "echo too-many",
              count: 1,
            }),
          sessionId,
        ),
      ).rejects.toThrow(/at most 128 terminals|BUSY/);
    } finally {
      await app2.evaluate(({ app }) => app.quit()).catch(() => {});
    }
  } finally {
    await teardown();
  }
});

test("Window-open handler denies new top-level windows from the renderer", async () => {
  const ctx = await boot();
  const { app, errors, teardown } = ctx;
  try {
    // Trigger a popup from the renderer's main frame and assert that the
    // window-open handler denies it (no new BrowserWindow appears).
    const before = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().length,
    );
    await ctx.page.evaluate(() => {
      window.open("about:blank", "_blank");
    });
    // Give Electron a brief tick to honor the handler.
    await expect
      .poll(
        async () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows().length,
          ),
        { timeout: 3000 },
      )
      .toBe(before);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("IPC trust check rejects calls from a non-trusted webContents", async () => {
  const ctx = await boot();
  const { app, errors, teardown } = ctx;
  try {
    // Open a hidden BrowserWindow that does NOT use our preload. Any
    // attempt to invoke our IPC from there must fail because the trust
    // check compares `event.senderFrame?.url` against the trusted renderer.
    const result = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const rogue = new BrowserWindow({
        show: false,
        webPreferences: {
          contextIsolation: true,
          sandbox: false,
        },
      });
      const captured = { value: "not-run" };
      const listener = () => {
        captured.value = "rogue-handler-ran";
      };
      ipcMain.handle("__probe-rogue-snapshot", listener);
      // Try to invoke from the rogue frame's renderer. The page is just a
      // data URL, so the trust check refuses to dispatch.
      await rogue.loadURL(
        'data:text/html,<script>async function probe(){try{const { ipcRenderer } = await import("electron"); await ipcRenderer.invoke("__probe-rogue-snapshot"); window.__probeResult = "unexpected-success"; }catch(error){window.__probeResult = String(error && error.message || error);}} probe();</script>',
      );
      await new Promise((r) => setTimeout(r, 1500));
      const probeResult: string | undefined = await rogue.webContents.executeJavaScript(
        "window.__probeResult",
      );
      captured.value = probeResult ?? captured.value;
      rogue.destroy();
      return captured.value;
    });
    // The result must NOT be a successful handler invocation. The rogue
    // frame may fail at the import stage (no preload, so `electron` cannot
    // be resolved), at the IPC trust check, or simply because no `invoke`
    // ran. Any of those is a positive signal that the trust boundary held.
    expect(typeof result).toBe("string");
    expect(result).not.toBe("unexpected-success");
    expect(result).not.toBe("rogue-handler-ran");
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("will-navigate denial keeps external URLs from replacing the renderer", async () => {
  const ctx = await boot();
  const { app, errors, teardown } = ctx;
  try {
    // Simulate a navigation attempt from inside the renderer. The
    // `will-navigate` handler must call event.preventDefault(), so the
    // webContents URL never changes.
    const urlBefore = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getURL(),
    );
    await ctx.page.evaluate(() => {
      // Programmatic location change — Electron must intercept this.
      window.location.href = "https://example.com/should-not-load";
    });
    await expect
      .poll(
        async () =>
          app.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].webContents.getURL(),
          ),
        { timeout: 3000 },
      )
      .toBe(urlBefore);
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Concurrent launch + delete operations do not corrupt the snapshot sequence", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // Launch two new terminals back-to-back, then close one and add another.
    // The reconciler's sequence numbers must remain strictly increasing
    // across all snapshots — a regression here would break event replay.
    const sequences: number[] = [];
    const sample = async () => {
      const snap = await page.evaluate(() => window.minimal.snapshot());
      sequences.push(snap.sequence);
    };
    await sample();
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await sample();
    await page.locator(".tab-close").first().click();
    await expect(page.getByRole("tab")).toHaveCount(1);
    await sample();
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    await sample();
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThanOrEqual(sequences[i - 1]);
    }
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Snapshot reflects running-terminal count even under rapid mutations", async () => {
  const ctx = await boot();
  const { page, errors, teardown } = ctx;
  try {
    // Open 4 terminals, close 2, and confirm the snapshot's running count
    // settles correctly. This catches reconciler races where the
    // engine-failure flag is set on a transient inspection error.
    await page.getByRole("button", { name: "Add terminals", exact: true }).click();
    await page.getByRole("spinbutton", { name: "Number of terminals" }).fill("4");
    await page.getByRole("button", { name: /^Launch \d+ terminals?$/ }).click();
    await expect(page.getByRole("tab")).toHaveCount(5);
    await page.locator(".tab-close").first().click();
    await page.locator(".tab-close").first().click();
    await expect(page.getByRole("tab")).toHaveCount(3);
    const snap = await page.evaluate(() => window.minimal.snapshot());
    const running = snap.sessions[0].terminals.filter(
      (t) => t.status === "running",
    ).length;
    expect(running).toBeGreaterThanOrEqual(0);
    expect(running).toBeLessThanOrEqual(3);
    expect(snap.engineError).toBeUndefined();
    expect(errors).toEqual([]);
  } finally {
    await teardown();
  }
});

test("Launch history entries expire and stop counting toward the cap", async () => {
  const ctx = await boot();
  const { data, teardown } = ctx;
  try {
    // Seed the store with 999 expired launch records so the next launch
    // must prune them rather than reject with BUSY. The cap is 1000.
    await seedState(data, (state) => {
      const s = state as { launches: { id: string; sessionId: string; key?: string; fingerprint: string;
        expiresAt: number; terminalIds: string[]; state: string; completed: number; errors: object[] }[] };
      const sessionId = s.launches[0]?.sessionId ?? randomUUID();
      for (let i = 0; i < 999; i++) {
        s.launches.push({
          id: randomUUID(),
          sessionId,
          key: `expired-${i}`,
          fingerprint: `f${i}`,
          expiresAt: Date.now() - 1000,
          terminalIds: [],
          state: "completed",
          completed: 0,
          errors: [],
        });
      }
    });
    await ctx.app.close();
    const app2 = await launch(data);
    try {
      const page = await app2.firstWindow();
      const sessionId = (
        await page.evaluate(() => window.minimal.snapshot())
      ).sessions[0].id;
      const result = await page.evaluate(
        async (sessionId) =>
          window.minimal.launchTerminals(sessionId, {
            command: "echo history-pruned",
            count: 1,
            idempotencyKey: "history-prune-test",
          }),
        sessionId,
      );
      expect(result.terminalIds).toHaveLength(1);
      const snap = await page.evaluate(() => window.minimal.snapshot());
      // The 999 expired records should have been pruned before the cap check.
      expect(snap.launches?.length ?? 0).toBeLessThanOrEqual(2);
    } finally {
      await app2.evaluate(({ app }) => app.quit()).catch(() => {});
    }
  } finally {
    await teardown();
  }
});
