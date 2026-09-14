import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../shared/types";
import type { FileAction, FileResults } from "../shared/files";
import { AppError, asFailure, type Failure } from "../shared/errors";
import { API_VERSION, methods, unwrap, checkFrame, parseSignal, type InputArgs, type Method, type Request, type Result } from "../shared/protocol";

async function invoke<M extends Method>(method: M, ...args: InputArgs<M>): Promise<Result<M>> {
  methods[method].request.parse(args);
  const request: Request = { apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
    method, deadlineAt: Date.now() + methods[method].timeoutMs, args };
  checkFrame(request);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      ipcRenderer.invoke(method, request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ipcRenderer.send("cancel-request", { apiVersion: API_VERSION, id: request.id });
          reject(new AppError("TIMEOUT", "The application did not reply; refresh before retrying", { outcomeUnknown: true }));
        }, methods[method].timeoutMs + 1000);
      }),
    ]);
    return unwrap(request, args, response);
  } finally { clearTimeout(timer); }
}
const ready = invoke("hello");
const failures = new Set<(failure: Failure) => void>();
function signalFailure(error: unknown) {
  const failure = asFailure(error, "terminal-stream");
  for (const listener of failures) listener(failure);
}
void ready.catch(() => {}); // Consumers receive the same failed handshake, without retrying it.
async function call<M extends Method>(method: M, ...args: InputArgs<M>): Promise<Result<M>> {
  await ready;
  return invoke(method, ...args);
}
const api: API = {
  getAppInfo: () => ready,
  getSettings: () => call("get-settings"),
  listDrafts: () => call("list-drafts"),
  readDraft: id => call("read-draft", id),
  saveDraft: input => call("save-draft", input),
  removeDraft: id => call("remove-draft", id),
  snapshot: () => call("snapshot"),
  chooseDirectory: () => call("choose-directory"),
  createSession: (name, directory) =>
    call("create-session", name, directory),
  renameSession: (id, name) => call("rename-session", id, name),
  deleteSession: (id) => call("delete-session", id),
  createTerminals: (sessionId, presetId, count, cwd) =>
    call("create-terminals", sessionId, presetId, count, cwd),
  launchTerminals: (sessionId, request) =>
    call("launch-terminals", sessionId, request),
  renameTerminal: (sessionId, terminalId, label) =>
    call("rename-terminal", sessionId, terminalId, label),
  deleteTerminal: (sessionId, terminalId) =>
    call("delete-terminal", sessionId, terminalId),
  savePresets: (presets) => call("save-presets", presets),
  files: <A extends FileAction>(sessionId: string, request: A) =>
    call("files", sessionId, request) as Promise<FileResults[A["action"]]>,
  attach: (id, cols, rows) => call("attach", id, cols, rows),
  detach: (token) => call("detach", token),
  input: (token, data) => call("input", token, data) as Promise<{ admitted: number }>,
  cancelInput: (token) => call("cancel-input", token) as Promise<{ dropped: number }>,
  resize: (token, cols, rows) => {
    const value = { apiVersion: API_VERSION, args: [token, cols, rows] };
    parseSignal("resize", value); ipcRenderer.send("resize", value);
  },
  acknowledge: (token, bytes) => {
    const value = { apiVersion: API_VERSION, args: [token, bytes] };
    parseSignal("acknowledge", value); ipcRenderer.send("acknowledge", value);
  },
  readClipboard: () => call("read-clipboard"),
  writeClipboard: (text) => call("write-clipboard", text),
  stopRuntime: () => ipcRenderer.invoke("stop-runtime") as Promise<{ accepted: boolean }>,
  onOutput: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
      let parsed: [string, string];
      try { parsed = parseSignal("terminal-output", value); }
      catch (error) { signalFailure(error); return; }
      listener(...parsed);
    };
    ipcRenderer.on("terminal-output", wrapped);
    return () => {
      ipcRenderer.removeListener("terminal-output", wrapped);
    };
  },
  onExit: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
      let token: string;
      try { [token] = parseSignal("terminal-exit", value); }
      catch (error) { signalFailure(error); return; }
      listener(token);
    };
    ipcRenderer.on("terminal-exit", wrapped);
    return () => {
      ipcRenderer.removeListener("terminal-exit", wrapped);
    };
  },
  onStartupRecovered: (listener) => {
    let active = true;
    void call("startup-recovery").then(message => {
      if (active && typeof message === "string") listener(message);
    }).catch(() => { if (active) listener("Could not read startup recovery status"); });
    return () => { active = false; };
  },
  onProtocolFailure: listener => { failures.add(listener); return () => { failures.delete(listener); }; },
  onWorkspaceChanged: listener => {
    const wrapped = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try { parseSignal("workspace-changed", value); }
      catch (error) { signalFailure(error); return; }
      listener();
    };
    ipcRenderer.on("workspace-changed", wrapped);
    return () => { ipcRenderer.removeListener("workspace-changed", wrapped); };
  },
};
contextBridge.exposeInMainWorld("minimal", api);
