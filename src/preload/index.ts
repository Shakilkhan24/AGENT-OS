import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/types";
const api: API = {
  snapshot: () => ipcRenderer.invoke("snapshot"),
  chooseDirectory: () => ipcRenderer.invoke("choose-directory"),
  createSession: (name, directory) =>
    ipcRenderer.invoke("create-session", name, directory),
  renameSession: (id, name) => ipcRenderer.invoke("rename-session", id, name),
  deleteSession: (id) => ipcRenderer.invoke("delete-session", id),
  createTerminals: (sessionId, presetId, count, cwd) =>
    ipcRenderer.invoke("create-terminals", sessionId, presetId, count, cwd),
  launchTerminals: (sessionId, request) =>
    ipcRenderer.invoke("launch-terminals", sessionId, request),
  renameTerminal: (sessionId, terminalId, label) =>
    ipcRenderer.invoke("rename-terminal", sessionId, terminalId, label),
  deleteTerminal: (sessionId, terminalId) =>
    ipcRenderer.invoke("delete-terminal", sessionId, terminalId),
  savePresets: (presets) => ipcRenderer.invoke("save-presets", presets),
  files: (sessionId, request) =>
    ipcRenderer.invoke("files", sessionId, request),
  attach: (id, cols, rows) => ipcRenderer.invoke("attach", id, cols, rows),
  detach: (token) => ipcRenderer.invoke("detach", token),
  input: (token, data) => ipcRenderer.invoke("input", token, data),
  resize: (token, cols, rows) => ipcRenderer.send("resize", token, cols, rows),
  acknowledge: (token, bytes) => ipcRenderer.send("acknowledge", token, bytes),
  readClipboard: () => ipcRenderer.invoke("read-clipboard"),
  writeClipboard: (text) => ipcRenderer.invoke("write-clipboard", text),
  onOutput: (listener) => {
    const wrapped = (
      _event: Electron.IpcRendererEvent,
      token: string,
      data: string,
    ) => listener(token, data);
    ipcRenderer.on("terminal-output", wrapped);
    return () => {
      ipcRenderer.removeListener("terminal-output", wrapped);
    };
  },
  onExit: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, token: string) =>
      listener(token);
    ipcRenderer.on("terminal-exit", wrapped);
    return () => {
      ipcRenderer.removeListener("terminal-exit", wrapped);
    };
  },
};
contextBridge.exposeInMainWorld("minimal", api);
