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
import { fileActionSchema } from "../shared/files";
import { Store } from "./store";
import { TmuxEngine, type Attachment } from "./engine";
import { SessionFilesystem } from "./filesystem";
import { SessionService } from "./service";
import { Logger, configureLogging, log } from "./logging";
import { SettingsStore } from "./settings-store";
import { DraftStore } from "./draft-store";

if (process.env.MINIMAL_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.MINIMAL_DATA_DIR));
app.setName("MINIMAL");
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let filesystem: SessionFilesystem | undefined;
let workspace: SessionService | undefined;
let attachment: Attachment | undefined;
let attachmentGeneration = 0;
const detach = () => {
  attachment?.close();
  attachment = undefined;
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
      const location = path.join(__dirname, "../renderer/index.html");
      const rendererUrl = pathToFileURL(location).href;
      const directory = app.getPath("userData");
      configureLogging(new Logger(path.join(directory, "logs")));
      const settings = await new SettingsStore(directory).load();
      const drafts = new DraftStore(directory, settings.draftLimit);
      configureLogging(
        new Logger(path.join(directory, "logs"), settings.logRetentionDays),
      );
      log({
        level: "info",
        source: "application",
        event: "started",
        fields: { version: app.getVersion() },
      });
      filesystem = new SessionFilesystem(
        path.join(__dirname, "../helpers/filesystem.py"),
        settings,
      );
      const engine = new TmuxEngine(
        directory,
        path.join(__dirname, "../helpers/pty_bridge.py"),
        settings,
      );
      const service = new SessionService(
        new Store(directory),
        engine,
        filesystem,
        settings,
      );
      await service.initialize();
      workspace = service;
      service.start();
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
      const dimensions = (cols: unknown, rows: unknown) => [
        z.number().int().min(2).max(500).parse(cols),
        z.number().int().min(2).max(250).parse(rows),
      ];
      const handle = (channel: string, callback: (...args: any[]) => any) =>
        ipcMain.handle(channel, (event, ...args) => {
          trusted(event);
          return callback(...args);
        });
      handle("snapshot", () => service.snapshot());
      handle("get-settings", () => settings);
      handle("list-drafts", () => drafts.list());
      handle("read-draft", draftId => drafts.read(draftId));
      handle("save-draft", input => {
        service.state.session(input.sessionId);
        return drafts.save(input);
      });
      handle("remove-draft", draftId => drafts.remove(draftId));
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
      handle("create-session", (name, directory) =>
        service.createSession(name, directory),
      );
      handle("rename-session", (sessionId, name) =>
        service.renameSession(id.parse(sessionId), name),
      );
      handle("delete-session", (sessionId) =>
        service.deleteSession(id.parse(sessionId)),
      );
      handle("create-terminals", (sessionId, presetId, count, cwd) =>
        service.createTerminals(
          id.parse(sessionId),
          id.parse(presetId),
          count,
          cwd,
        ),
      );
      handle("launch-terminals", (sessionId, request) =>
        service.launchTerminals(id.parse(sessionId), request),
      );
      handle("rename-terminal", (sessionId, terminalId, label) =>
        service.renameTerminal(
          id.parse(sessionId),
          id.parse(terminalId),
          label,
        ),
      );
      handle("delete-terminal", (sessionId, terminalId) =>
        service.deleteTerminal(id.parse(sessionId), id.parse(terminalId)),
      );
      handle("save-presets", (presets) => service.savePresets(presets));
      handle("files", (sessionId, request) =>
        service.files(id.parse(sessionId), fileActionSchema.parse(request)),
      );
      handle("attach", async (terminalId, cols, rows) => {
        const generation = ++attachmentGeneration;
        terminalId = id.parse(terminalId);
        const [c, r] = dimensions(cols, rows);
        await service.requireTerminal(terminalId);
        if (generation !== attachmentGeneration)
          throw new Error("Terminal selection changed");
        detach();
        attachment = engine.attach(
          terminalId,
          c,
          r,
          (token, data) => {
            if (!window?.isDestroyed())
              window?.webContents.send("terminal-output", token, data);
          },
          (token) => {
            if (!window?.isDestroyed())
              window?.webContents.send("terminal-exit", token);
          },
        );
        return attachment.token;
      });
      handle("detach", (token) => {
        if (attachment?.token === id.parse(token)) detach();
      });
      handle("input", (token, data) => {
        if (attachment?.token !== id.parse(token))
          throw new Error(
            "Terminal connection changed. Reconnect before typing.",
          );
        return attachment.input(z.string().max(65536).parse(data));
      });
      for (const channel of ["resize", "acknowledge"])
        ipcMain.on(channel, (event, token, first, second) => {
          try {
            trusted(event);
            if (attachment?.token !== id.parse(token)) return;
            if (channel === "resize") {
              const [c, r] = dimensions(first, second);
              attachment.resize(c, r);
            } else
              attachment.acknowledge(
                z
                  .number()
                  .int()
                  .min(0)
                  .max(1024 * 1024)
                  .parse(first),
              );
          } catch (error) {
            log({
              level: "warning",
              source: "ipc",
              event: "message-rejected",
              fields: {
                channel,
                kind: error instanceof Error ? error.name : "unknown",
              },
            });
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
      await window.loadFile(location);
    })
    .catch((error) => {
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
      app.quit();
    });
}
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => {
  workspace?.close();
  detach();
  filesystem?.close();
});
