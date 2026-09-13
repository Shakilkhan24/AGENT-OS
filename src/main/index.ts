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
import { RuntimeWorkspace } from "../runtime/workspace";
import type { RuntimeEndpoint } from "../runtime/control-server";
import { AppError } from "../shared/errors";
import { API_VERSION, methods, parseSignal, parseResult, type Method, type RequestArgs, type Result, type InvocationContext } from "../shared/protocol";

if (process.env.MINIMAL_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.MINIMAL_DATA_DIR));
app.setName("MINIMAL");
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let workspace: RuntimeWorkspace | undefined;
let endpoint: RuntimeEndpoint | undefined;
let quitRequested = false;
const pendingRequests = new Set<Promise<unknown>>();
const protocol = new ProtocolDispatcher();
const detach = () => endpoint?.detachView();
if (!locked) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const location = path.join(__dirname, "../renderer/index.html");
      const rendererUrl = pathToFileURL(location).href;
      const directory = app.getPath("userData");
      configureLogging(new Logger(path.join(directory, "logs")));
      workspace = await RuntimeWorkspace.open(directory, path.join(__dirname, "../helpers"), app.getVersion());
      configureLogging(new Logger(path.join(directory, "logs"), workspace.settings.logRetentionDays));
      log({ level: "info", source: "application", event: "started", fields: { version: app.getVersion() } });
      endpoint = workspace.connect({ connectionId: crypto.randomUUID(), profileKey: profilePaths(directory).key, principal: "desktop" }, message => {
        if (window && !window.isDestroyed()) window.webContents.send(message.name, message.envelope);
      });
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
          const cancel = () => endpoint!.cancel(context.requestId);
          context.signal.addEventListener("abort", cancel, { once: true });
          try {
            context.signal.throwIfAborted();
            const response = await endpoint!.dispatch({ apiVersion: API_VERSION, id: context.requestId,
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
            endpoint!.signal({ type: "signal", name: channel, envelope: { apiVersion: API_VERSION, args } });
          } catch (error) {
            log({ level: "warning", source: "ipc", event: "message-rejected",
              fields: { channel, kind: error instanceof Error ? error.name : "unknown" } });
          }
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
      if (!workspace) { app.exit(1); return; }
      app.quit();
    });
}
let shuttingDown = false;
const SHUTDOWN_FLUSH_BUDGET_MS = 5000;
app.on("window-all-closed", () => app.quit());
function flushBeforeQuit(event: Electron.Event) {
  // Flush pending state.json and event-journal writes before the process
  // exits. Without this the debouncer's window can drop the last mutation.
  // The watchdog caps the wait — see src/main/shutdown.ts.
  if (workspace) {
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    detach();
    const watchdog = runWithWatchdog(async () => {
      const launches = workspace!.service.launches.close();
      const pending = await Promise.allSettled([launches, protocol.close(), ...pendingRequests]);
      const services = await Promise.allSettled([workspace!.close()]);
      const failure = [...pending, ...services].find(result => result.status === "rejected");
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
