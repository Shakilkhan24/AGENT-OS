import {
  app,
  BrowserWindow,
  dialog,
  clipboard,
  ipcMain,
  session as electronSession,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { Logger, configureLogging, log } from "./logging";
import { runWithWatchdog } from "./shutdown";
import { ProtocolDispatcher } from "./protocol-dispatcher";
import { profilePaths } from "./profile-runtime";
import { ControlClient } from "../runtime/control-client";
import { AppError } from "../shared/errors";
import { API_VERSION, methods, parseSignal, parseResult, type Method, type RequestArgs, type Result, type InvocationContext } from "../shared/protocol";
import { launchRuntime, resolveRuntimePaths, type RuntimeHandle } from "./runtime-launcher";
import { probeCompatibility } from "../release/compatibility-check";

if (process.env.MINIMAL_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.MINIMAL_DATA_DIR));
app.setName("MINIMAL");
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let client: ControlClient | undefined;
let runtime: RuntimeHandle | undefined;
let runtimeStarted = false;
let quitRequested = false;
const pendingRequests = new Set<Promise<unknown>>();
const protocol = new ProtocolDispatcher();
const detach = () => {
  client?.close();
};
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      // M9.3: wire up the Linux/WSLg AT-SPI bridge so assistive technologies
      // (Orca, NVDA via WSLg) can reach the renderer. No-op on platforms
      // without an a11y bus. Kept before any BrowserWindow construction so
      // the bridge is alive for the first render.
      app.setAccessibilitySupportEnabled(true);
      const location = path.join(__dirname, "../renderer/index.html");
      const rendererUrl = pathToFileURL(location).href;
      const directory = app.getPath("userData");
      // The runtime owns its own logging (it sees workspace settings on open); the
      // desktop logger simply captures startup, IPC and shutdown lines.
      configureLogging(new Logger(path.join(directory, "logs")));
      // M9.4: probe host compatibility at startup. The probe result
      // is logged as an operational record so a reviewer can audit
      // it post-hoc; a probe failure never blocks startup.
      try {
        const probe = await probeCompatibility();
        log({
          level: probe.supported ? "info" : "warning",
          source: "diagnostics",
          event: "compatibility-probe",
          fields: {
            architecture: probe.architecture,
            runtime: probe.runtime,
            filesystem: probe.filesystem,
            distro: probe.distro,
            providers: probe.providers,
            sqliteAvailable: probe.sqliteAvailable,
            rootlessContainerEngine: probe.rootlessContainerEngine,
            supported: probe.supported,
            unsupportedReasons: probe.unsupportedReasons,
          },
        });
      } catch (error) {
        log({
          level: "warning",
          source: "diagnostics",
          event: "compatibility-probe-failed",
          fields: {
            kind: error instanceof Error ? error.name : "unknown",
          },
        });
      }
      const helpersDir = path.join(__dirname, "../helpers");
      const paths = profilePaths(directory);
      const resolved = resolveRuntimePaths(helpersDir, path.join(__dirname, ".."));
      // M1.3+M1.4: the runtime is a separate, OS-locked Node-mode Electron process
      // gated on the per-profile lock inode. `client.ready` blocks until the
      // welcome round-trip succeeds, so subsequent IPC calls cannot precede auth.
      runtime = await launchRuntime({
        dataDir: directory,
        helpersDir,
        executable: resolved.executable,
        runtimeEntry: resolved.runtimeEntry,
        runtimeDir: paths.runtime,
        socketPath: paths.socket,
        lockPath: paths.lock,
      });
      runtimeStarted = true;
      client = new ControlClient(paths.socket,
        { profileKey: paths.key, token: runtime.token },
        message => { if (window && !window.isDestroyed()) window.webContents.send(message.name, message.envelope); });
      await client.ready;
      log({ level: "info", source: "application", event: "started", fields: {
        version: app.getVersion(), mode: "runtime-child", pid: runtime.pid, incarnation: runtime.incarnation,
      } });
      electronSession.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      electronSession.defaultSession.setPermissionCheckHandler(() => false);
      const trusted = (
        event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
      ) => {
        if (
          !window ||
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          event.senderFrame?.url !== rendererUrl
        )
          throw new Error("Untrusted IPC sender");
      };
      const id = z.string().uuid();
      const wire = <M extends Method>(channel: M, callback: (args: RequestArgs<M>, context: InvocationContext) => Result<M> | Promise<Result<M>>) => {
        protocol.register(channel, callback);
        ipcMain.handle(channel, (event, request: unknown) => {
          trusted(event);
          const pending = protocol.dispatch(channel, request);
          pendingRequests.add(pending);
          return pending.finally(() => pendingRequests.delete(pending));
        });
      };
      const handle = <M extends Method>(channel: M, callback: (...args: RequestArgs<M>) => Result<M> | Promise<Result<M>>) => wire(channel, args => callback(...args));
      ipcMain.on("cancel-request", (event, value: unknown) => {
        try {
          trusted(event);
          const cancellation = z.object({ apiVersion: z.literal(API_VERSION), id }).strict().parse(value);
          protocol.cancel(cancellation.id);
        } catch {
          log({ level: "warning", source: "protocol", event: "cancellation-rejected" });
        }
      });
      handle("read-clipboard", () => clipboard.readText());
      handle("write-clipboard", (text) =>
        clipboard.writeText(
          z
            .string()
            .max(2 * 1024 * 1024)
            .parse(text),
        ),
      );
      handle("choose-directory", async () => {
        const result = await dialog.showOpenDialog(window!, {
          title: "Choose a session directory",
          properties: ["openDirectory", "createDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      });
      for (const channel of Object.keys(methods) as Method[]) {
        if (channel === "read-clipboard" || channel === "write-clipboard" || channel === "choose-directory") continue;
        wire(channel, async (args, context) => {
          const cancel = () => client!.cancel(context.requestId);
          context.signal.addEventListener("abort", cancel, { once: true });
          try {
            context.signal.throwIfAborted();
            const response = await client!.dispatch({ apiVersion: API_VERSION, id: context.requestId,
              correlationId: context.correlationId, deadlineAt: context.deadlineAt, method: channel, args });
            if (!response.ok) throw new AppError(response.error.code, response.error.message, response.error);
            return parseResult(channel, args, response.result);
          } finally { context.signal.removeEventListener("abort", cancel); }
        });
      }
      for (const channel of ["resize", "acknowledge"] as const)
        ipcMain.on(channel, (event, value: unknown) => {
          try {
            trusted(event);
            const args = parseSignal(channel, value);
            client!.signal({ type: "signal", name: channel, envelope: { apiVersion: API_VERSION, args } });
          } catch (error) {
            log({ level: "warning", source: "ipc", event: "message-rejected",
              fields: { channel, kind: error instanceof Error ? error.name : "unknown" } });
          }
        });
      // M1.6: explicit user-initiated "stop runtime and quit". Window close and
      // GUI crash do not invoke this; the runtime keeps running.
      ipcMain.handle("stop-runtime", (event) => {
        try { trusted(event); } catch { throw new Error("Untrusted IPC sender"); }
        if (!runtimeStarted || !runtime) throw new Error("Runtime is not running");
        stoppingRuntime = true;
        app.quit();
        return { accepted: true };
      });
      window = new BrowserWindow({
        width: 1440,
        height: 920,
        minWidth: 1000,
        minHeight: 640,
        backgroundColor: "#111314",
        title: "MINIMAL",
        autoHideMenuBar: true,
        webPreferences: {
          preload: path.join(__dirname, "../preload/index.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          spellcheck: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      window.webContents.on("render-process-gone", detach);
      window.on("closed", () => {
        detach();
        window = undefined;
      });
      // If `Store.load()` couldn't parse the existing state.json, it
      // backs up the file and falls back to the empty default. The preload
      // queries the recovery notice after subscribing, avoiding a load race.
      await window.loadFile(location);
    })
    .catch((error) => {
      // Closing during the initial page load aborts loadFile. A modal startup
      // error here would interrupt the shutdown already requested by the user.
      if (quitRequested) return;
      log({
        level: "error",
        source: "application",
        event: "startup-failed",
        fields: { kind: error instanceof Error ? error.name : "unknown" },
      });
      dialog.showErrorBox(
        "MINIMAL could not start",
        String(error.message || error),
      );
      if (!runtimeStarted) { app.exit(1); return; }
      app.quit();
    });
}
let shuttingDown = false;
let stoppingRuntime = false;
const SHUTDOWN_FLUSH_BUDGET_MS = 5000;
app.on("window-all-closed", () => app.quit());
/**
 * M1.6: "close window" drains pending IPC and acknowledged drafts on the
 * desktop side, then exits the GUI process. The runtime child is intentionally
 * left running so tmux work survives across desktop restarts; the next launch
 * either re-attaches to the existing runtime (per `tryAttachRuntime`) or starts
 * a fresh one. To terminate the runtime and its durable work the user must
 * invoke the explicit `stop-runtime` IPC, which sets `stoppingRuntime` so
 * `flushBeforeQuit` knows to forward SIGTERM.
 */
function flushBeforeQuit(event: Electron.Event) {
  if (runtimeStarted) {
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    detach();
    log({ level: "info", source: "application", event: "desktop-shutdown",
      fields: { mode: stoppingRuntime ? "stop-runtime" : "window-closed" } });
    const watchdog = runWithWatchdog(async () => {
      const pending = await Promise.allSettled([client!.dispatch({
        apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
        deadlineAt: Date.now() + 1000, method: "snapshot", args: [],
      }).catch(() => null), protocol.close(), ...pendingRequests]);
      client!.close();
      // Only the explicit "stop runtime" path signals the child. A window close
      // (or a desktop crash) leaves the OS-locked runtime serving this profile.
      if (stoppingRuntime) await runtime!.stop("SIGTERM", SHUTDOWN_FLUSH_BUDGET_MS);
      const failure = pending.find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }, {
      budgetMs: SHUTDOWN_FLUSH_BUDGET_MS,
      onTimeout: () => app.exit(1),
    });
    watchdog.done.then(outcome => app.exit(outcome === "completed" ? 0 : 1));
  }
}

app.on("before-quit", event => {
  quitRequested = true;
  // Chromium can block window closure during navigation. Drain directly in
  // that case; before the initial load there is no editor to flush on unload.
  if (window?.webContents.isLoadingMainFrame()) flushBeforeQuit(event);
});
app.on("will-quit", flushBeforeQuit);
