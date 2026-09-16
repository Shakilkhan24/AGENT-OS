import { z } from "zod";
import { AppError, failureSchema } from "./errors";
import { draftInputSchema, draftSchema, draftSummarySchema } from "./drafts";
import { fileActionSchema, resultSchemas } from "./files";
import { launchSchema } from "./launch";
import { sessionSchema, terminalSchema, presetSchema, launchRecordSchema, nameSchema } from "./models";
import { envProfileSchema } from "./env-profiles";
import { hookSchema } from "./hooks";
import { terminalStatusSchema } from "./events";
import { settingsSchema } from "./settings";
import { utf8Bytes } from "./terminal-flow";
import { managedProjectionSchema, managedProjectionUnavailableSchema } from "./managed-view";
import { executeVerificationInputSchema, executeVerificationResultSchema,
  recordReviewDecisionInputSchema, recordReviewDecisionResultSchema,
  transitionAttentionInputSchema, transitionAttentionResultSchema,
  snoozeAttentionInputSchema, snoozeAttentionResultSchema,
  previewArtifactInputSchema, previewArtifactResultSchema,
  renderCandidateDiffInputSchema, renderCandidateDiffResultSchema,
  readTaskPromptDraftInputSchema, readTaskPromptDraftResultSchema,
  saveTaskPromptDraftInputSchema, saveTaskPromptDraftResultSchema,
  removeTaskPromptDraftInputSchema, removeTaskPromptDraftResultSchema,
  answerAttentionInputSchema, answerAttentionResultSchema,
  continueInvocationInputSchema, continueInvocationResultSchema,
  newAttemptInputSchema, newAttemptResultSchema,
  requestStopInputSchema, requestStopResultSchema } from "./managed-schema";
import {
  clearLayoutInputSchema, clearLayoutResultSchema,
  deleteTerminalHistoryInputSchema, deleteTerminalHistoryResultSchema,
  hideTerminalInputSchema, hideTerminalResultSchema,
  readLayoutInputSchema, readLayoutResultSchema,
  saveEnvProfilesInputSchema, saveEnvProfilesResultSchema,
  saveHooksInputSchema, saveHooksResultSchema,
  saveLayoutInputSchema, saveLayoutResultSchema,
  stopAndRemoveTerminalInputSchema, stopAndRemoveTerminalResultSchema,
  updateSessionMetadataInputSchema, updateSessionMetadataResultSchema,
  viewSessionMemoryInputSchema, viewTaskMemoryInputSchema, viewTerminalMemoryInputSchema,
} from "./workspace6-schema";

export const API_VERSION = 1;
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_DEADLINE_MS = 10 * 60 * 1000;
const id = z.string().uuid();
const text = z.string().max(2 * 1024 * 1024);
const columns = z.number().int().min(2).max(500), rows = z.number().int().min(2).max(250);
const terminalView = terminalSchema.extend({ status: terminalStatusSchema, pid: z.number().int().positive().optional(),
  process: z.string().optional(), currentDirectory: z.string().optional() });
export const snapshotSchema = z.object({
  sequence: z.number().int().nonnegative(), sessions: z.array(sessionSchema.extend({ terminals: z.array(terminalView) })),
  presets: z.array(presetSchema), engineError: z.string().optional(), engineFailure: failureSchema.optional(),
  envProfiles: z.array(envProfileSchema).optional(), hooks: z.array(hookSchema).optional(), launches: z.array(launchRecordSchema).optional(),
  // M3c.1: opt-in projection of M3a/M3b entities. Absent when the runtime
  // is degraded or the DB driver opted out; existing renderer code treats
  // an absent block the same as the legacy M2 surface.
  managed: z.union([managedProjectionSchema, managedProjectionUnavailableSchema]).optional(),
});
const launchResult = snapshotSchema.extend({ launchId: id.optional(), terminalIds: z.array(id),
  launchErrors: z.array(z.object({ terminalId: id, error: z.string() })) });
function method<P extends z.ZodType, R extends z.ZodType>(request: P, response: R, timeoutMs = 30000) {
  return { request, response, timeoutMs };
}

/** Named operations remain stable across Electron IPC and the future runtime transport. */
export const methods = {
  hello: method(z.tuple([]), z.object({ apiVersion: z.literal(API_VERSION), appVersion: z.string(), incarnation: id })),
  snapshot: method(z.tuple([]), snapshotSchema),
  "get-settings": method(z.tuple([]), settingsSchema),
  "list-drafts": method(z.tuple([]), z.array(draftSummarySchema).max(100)),
  "read-draft": method(z.tuple([z.string().regex(/^[a-f0-9]{64}$/)]), draftSchema),
  "save-draft": method(z.tuple([draftInputSchema]), draftSummarySchema),
  "remove-draft": method(z.tuple([z.string().regex(/^[a-f0-9]{64}$/)]), z.void()),
  "read-clipboard": method(z.tuple([]), text),
  "write-clipboard": method(z.tuple([text]), z.void()),
  "choose-directory": method(z.tuple([]), z.string().max(4096).nullable(), MAX_DEADLINE_MS),
  "create-session": method(z.tuple([nameSchema, z.string().min(1).max(4096)]), snapshotSchema),
  "rename-session": method(z.tuple([id, nameSchema]), snapshotSchema),
  "delete-session": method(z.tuple([id]), snapshotSchema, MAX_DEADLINE_MS),
  "create-terminals": method(z.tuple([id, id, z.number().int().min(1).max(32), z.string().max(4096)]), launchResult, MAX_DEADLINE_MS),
  "launch-terminals": method(z.tuple([id, launchSchema]), launchResult, MAX_DEADLINE_MS),
  "rename-terminal": method(z.tuple([id, id, nameSchema]), snapshotSchema),
  "delete-terminal": method(z.tuple([id, id]), snapshotSchema),
  "save-presets": method(z.tuple([z.array(presetSchema).min(1).max(100)]), snapshotSchema),
  files: method(z.tuple([id, fileActionSchema]), z.union([
    resultSchemas.list, resultSchemas["list-page"], resultSchemas.read, resultSchemas.preview,
    resultSchemas.write, resultSchemas.create,
  ]), 125000),
  attach: method(z.tuple([id, columns, rows]), id),
  detach: method(z.tuple([id]), z.void()),
  input: method(z.tuple([id, z.string().max(65536)]), z.object({ admitted: z.number().int().min(0).max(65536) }).strict()),
  "cancel-input": method(z.tuple([id]), z.object({ dropped: z.number().int().min(0).max(8 * 1024 * 1024) }).strict()),
  "startup-recovery": method(z.tuple([]), z.string().nullable()),
  // M3c.2 — verifier executor + review decisions. The dispatcher handlers
  // live in `src/runtime/workspace.ts`; the desktop auto-forward loop in
  // `src/main/index.ts:124-137` picks up these keys automatically. Both
  // calls honour the request deadline; verifiers cap their own internal
  // deadline via `deadlineAt` in the executor path.
  "execute-verification": method(executeVerificationInputSchema, executeVerificationResultSchema, MAX_DEADLINE_MS),
  "record-review-decision": method(recordReviewDecisionInputSchema, recordReviewDecisionResultSchema),
  // M3c.3 — persistent attention inbox + bounded artifact previews.
  // The dispatcher handlers live in `src/runtime/workspace.ts`; the
  // desktop auto-forward loop in `src/main/index.ts:124-137` picks up
  // these keys automatically.
  "transition-attention": method(transitionAttentionInputSchema, transitionAttentionResultSchema),
  "snooze-attention": method(snoozeAttentionInputSchema, snoozeAttentionResultSchema),
  "preview-artifact": method(previewArtifactInputSchema, previewArtifactResultSchema),
  // M3c.4 — diff/artifact view. The renderer asks for the candidate
  // diff on demand; the runtime shells out to `git diff` inside the
  // run's worktree and applies the 256 KiB cap. `since: 1.4.0`.
  "render-candidate-diff": method(renderCandidateDiffInputSchema, renderCandidateDiffResultSchema, MAX_DEADLINE_MS),
  // M3c.5 — task-prompt drafts + four managed-work actions. The
  // dispatcher handlers live in `src/runtime/workspace.ts`; the
  // desktop auto-forward loop in `src/main/index.ts:124-137` picks
  // up these keys automatically.
  "read-task-prompt-draft": method(readTaskPromptDraftInputSchema, readTaskPromptDraftResultSchema),
  "save-task-prompt-draft": method(saveTaskPromptDraftInputSchema, saveTaskPromptDraftResultSchema),
  "remove-task-prompt-draft": method(removeTaskPromptDraftInputSchema, removeTaskPromptDraftResultSchema),
  "answer-attention": method(answerAttentionInputSchema, answerAttentionResultSchema),
  "continue-invocation": method(continueInvocationInputSchema, continueInvocationResultSchema, MAX_DEADLINE_MS),
  "new-attempt": method(newAttemptInputSchema, newAttemptResultSchema, MAX_DEADLINE_MS),
  "request-stop": method(requestStopInputSchema, requestStopResultSchema),
  // M5.6 — per-session metadata patch + env-profile / hook / memory IPC.
  // The renderer can keep using `Snapshot` for the legacy read paths; the
  // new IPC methods below let the M5.6 command palette + project-metadata
  // UI surface the same records without round-tripping through the legacy
  // `savePresets` IPC. Object payloads are wrapped in a single-element
  // tuple (matches the M3c.5 convention used by `continue-invocation`).
  "update-session-metadata": method(z.tuple([updateSessionMetadataInputSchema]), updateSessionMetadataResultSchema),
  "save-env-profiles": method(z.tuple([saveEnvProfilesInputSchema]), saveEnvProfilesResultSchema),
  "save-hooks": method(z.tuple([saveHooksInputSchema]), saveHooksResultSchema),
  // M5.6 — bounded memory-view IPC. The runtime validates and caps the
  // response (see `MEMORY_VIEW_MAX_*` in `runtime/db/memory-views.ts`),
  // so we declare the response as `z.unknown()` and let the runtime
  // layer's runtime result map back to its declared shape. The
  // view-function side of the IPC accepts the input via the workspace6
  // schema above; the response shape is governed by the runtime.
  "view-session-memory": method(z.tuple([viewSessionMemoryInputSchema]), z.unknown(), 5000),
  "view-terminal-memory": method(z.tuple([viewTerminalMemoryInputSchema]), z.unknown(), 5000),
  "view-task-memory": method(z.tuple([viewTaskMemoryInputSchema]), z.unknown(), 5000),
  // M5.6 — saved layout per sessionId.
  "save-layout": method(z.tuple([saveLayoutInputSchema]), saveLayoutResultSchema),
  "read-layout": method(z.tuple([readLayoutInputSchema]), readLayoutResultSchema),
  "clear-layout": method(z.tuple([clearLayoutInputSchema]), clearLayoutResultSchema),
  // M5.6 — explicit terminal lifecycle (hide / stop-and-remove /
  // delete-history). The renderer's `TerminalPanel` invokes one of
  // these instead of the legacy `delete-terminal` policy.
  "hide-terminal": method(z.tuple([hideTerminalInputSchema]), hideTerminalResultSchema),
  "stop-and-remove-terminal": method(z.tuple([stopAndRemoveTerminalInputSchema]), stopAndRemoveTerminalResultSchema, MAX_DEADLINE_MS),
  "delete-terminal-history": method(z.tuple([deleteTerminalHistoryInputSchema]), deleteTerminalHistoryResultSchema, MAX_DEADLINE_MS),
} as const;
export type Method = keyof typeof methods;
export type RequestArgs<M extends Method> = z.output<(typeof methods)[M]["request"]>;
export type InputArgs<M extends Method> = z.input<(typeof methods)[M]["request"]>;
export type Result<M extends Method> = z.output<(typeof methods)[M]["response"]>;
export const requestSchema = z.object({ apiVersion: z.number().int(), id, correlationId: id,
  method: z.enum(Object.keys(methods) as [Method, ...Method[]]), deadlineAt: z.number().int().nonnegative(), args: z.array(z.unknown()) }).strict();
export type Request = z.infer<typeof requestSchema>;
export const responseSchema = z.discriminatedUnion("ok", [
  z.object({ apiVersion: z.number().int(), id, ok: z.literal(true), result: z.unknown().optional() }).strict(),
  z.object({ apiVersion: z.number().int(), id, ok: z.literal(false), error: failureSchema }).strict(),
]);
export type Response = z.infer<typeof responseSchema>;
export interface InvocationContext {
  signal: AbortSignal;
  requestId: string;
  correlationId: string;
  deadlineAt: number;
}
export const signalEnvelopeSchema = z.object({ apiVersion: z.number().int(), args: z.array(z.unknown()).max(3) }).strict();
export const inputProgressSchema = z.array(z.object({
  token: z.string().min(1).max(256),
  queued: z.number().int().min(0).max(8 * 1024 * 1024),
  delivered: z.number().int().min(0).max(8 * 1024 * 1024),
})).max(32);
export const signals = {
  "workspace-changed": z.tuple([]),
  resize: z.tuple([id, columns, rows]),
  acknowledge: z.tuple([id, z.number().int().min(0).max(1024 * 1024)]),
  "terminal-output": z.tuple([id, z.string().max(1024 * 1024)]),
  "terminal-exit": z.tuple([id]),
  "terminal-input-progress": z.tuple([inputProgressSchema]),
};
export function parseSignal<M extends keyof typeof signals>(name: M, value: unknown): z.output<(typeof signals)[M]> {
  checkFrame(value);
  const envelope = signalEnvelopeSchema.parse(value); checkVersion(envelope.apiVersion);
  return signals[name].parse(envelope.args) as z.output<(typeof signals)[M]>;
}
export function checkVersion(version: number) {
  if (version !== API_VERSION) throw new AppError("VERSION_MISMATCH", `Incompatible MINIMAL API ${version}; expected ${API_VERSION}. Reopen a matching application release.`);
}
export function checkFrame(value: unknown) {
  let bytes: number;
  try {
    const json = JSON.stringify(value);
    if (json === undefined) throw new Error("Not JSON");
    bytes = utf8Bytes(json);
  }
  catch { throw new AppError("INVALID_REQUEST", "Protocol frame must be JSON serializable"); }
  if (bytes > MAX_FRAME_BYTES) throw new AppError("INVALID_REQUEST", "Protocol frame exceeds the byte limit");
}
export function parseRequest(value: unknown, now = Date.now()): Request {
  checkFrame(value);
  const request = requestSchema.parse(value);
  checkVersion(request.apiVersion);
  if (request.deadlineAt <= now) throw new AppError("TIMEOUT", "Request expired before admission");
  if (request.deadlineAt > now + MAX_DEADLINE_MS) throw new AppError("INVALID_REQUEST", "Request deadline exceeds the limit");
  methods[request.method].request.parse(request.args);
  return request;
}
export function parseResult<M extends Method>(method: M, args: InputArgs<M>, value: unknown): Result<M> {
  const result = methods[method].response.parse(value);
  if (method === "files") {
    const [, action] = methods.files.request.parse(args);
    resultSchemas[action.action].parse(result);
  }
  return result as Result<M>;
}
export function unwrap<M extends Method>(request: Request, args: InputArgs<M>, value: unknown): Result<M> {
  checkFrame(value);
  const response = responseSchema.parse(value);
  checkVersion(response.apiVersion);
  if (response.id !== request.id) throw new AppError("INVALID_REQUEST", "Response request ID mismatch");
  if (!response.ok) throw new AppError(response.error.code, response.error.message, response.error);
  return parseResult(request.method as M, args, response.result);
}
