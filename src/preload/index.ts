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
  executeVerification: (taskId, recipeId, override) =>
    call("execute-verification", taskId, recipeId, override ?? null),
  recordReviewDecision: (reviewId, decision, decidedBy) =>
    call("record-review-decision", reviewId, decision, decidedBy),
  // M3c.3 — persistent attention inbox + bounded artifact previews.
  transitionAttention: (id, to) =>
    call("transition-attention", id, to),
  snoozeAttention: (id, until) =>
    call("snooze-attention", id, until),
  previewArtifact: (id, principal, scopeJson) =>
    call("preview-artifact", id, principal, scopeJson ?? null),
  // M3c.4 — diff/artifact view. The runtime shells out to `git diff`
  // inside the run's worktree and returns a bounded unified diff
  // (cap = 256 KiB). The desktop auto-forward loop in
  // `src/main/index.ts:124-137` picks up the new method key.
  renderCandidateDiff: (runId) =>
    call("render-candidate-diff", runId),
  // M3c.5 — task-prompt drafts + four managed-work actions.
  readTaskPromptDraft: (taskId) =>
    call("read-task-prompt-draft", taskId),
  saveTaskPromptDraft: (taskId, input) =>
    call("save-task-prompt-draft", taskId, input),
  removeTaskPromptDraft: (taskId) =>
    call("remove-task-prompt-draft", taskId),
  answerAttention: (id, input) =>
    call("answer-attention", id, input),
  continueInvocation: (id, input) =>
    call("continue-invocation", id, input),
  newAttempt: (input) =>
    call("new-attempt", input),
  requestStop: (runId, input) =>
    call("request-stop", runId, input),
  // M6.1 — single workflow executor. The runtime validates the
  // graph, runs each step via its existing primitive seam
  // (executeOnce / verifyOnce / pinArtifact / readReview / execFile),
  // emits audit events, and returns the typed `WorkflowResult`.
  // The renderer receives an `{kind: "ok"} | {kind: "conflict"}`
  // envelope so a validation / dispatch failure surfaces as a
  // human reason without forcing the renderer to parse `Failure`
  // shape. Cast mirrors the `input` / `files` pattern: the
  // protocol layer declares the response as `z.unknown()` and the
  // dispatcher's `parseResult` enforces the strict result schema
  // at the wire boundary.
  runWorkflow: (input) =>
    call("run-workflow", input) as Promise<
      | { kind: "ok"; result: import("../shared/workflow-executor-schema").WorkflowResult }
      | { kind: "conflict"; reason: string }
    >,
  // M6.4 — durable workflow execution. Same envelope shape as
  // `runWorkflow`. The runtime persists a `workflow_run` row so a
  // restart resumes from the last completed step. Renderer
  // consumers gate this behind the M9.3 advanced-controls flag.
  runWorkflowDurable: (input) =>
    call("run-workflow-durable", input) as Promise<
      | { kind: "ok"; result: import("../shared/workflow-executor-schema").WorkflowResult }
      | { kind: "conflict"; reason: string }
    >,
  // M6.4 — live workflow-run snapshot. Read-side IPC used by
  // `WorkflowRunner.tsx`'s polling seam. Returns a typed
  // `WorkflowRunSnapshot` discriminated on `kind` ("absent" |
  // "present"). Matches the `view-session-memory` style — no
  // envelope; failures surface as a real IPC `failure` and the
  // renderer treats them as "no progress this tick".
  getWorkflowRun: (input) =>
    call("get-workflow-run", input) as Promise<
      import("../shared/workflow-executor-schema").WorkflowRunSnapshot
    >,
};
contextBridge.exposeInMainWorld("minimal", api);
