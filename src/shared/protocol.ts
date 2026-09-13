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
  input: method(z.tuple([id, z.string().max(65536)]), z.void()),
  "startup-recovery": method(z.tuple([]), z.string().nullable()),
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
export const signals = {
  "workspace-changed": z.tuple([]),
  resize: z.tuple([id, columns, rows]),
  acknowledge: z.tuple([id, z.number().int().min(0).max(1024 * 1024)]),
  "terminal-output": z.tuple([id, z.string().max(1024 * 1024)]),
  "terminal-exit": z.tuple([id]),
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
