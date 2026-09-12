import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../shared/types";
import { fileActionSchema, directoryActionSchema, resultSchemas, workerResponseSchema,
  type FileAction, type DirectoryAction, type FileResults } from "../shared/files";
import { AppError } from "../shared/errors";
import { defaultSettings, type Settings } from "../shared/settings";
import { Mutex } from "./mutex";
import { log } from "./logging";

type WorkerAction = keyof FileResults;
export interface FileOperationOptions { signal?: AbortSignal; correlationId?: string }
export class SessionFilesystem {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending?: { id: number; correlationId: string; resolve(value: unknown): void; reject(error: Error): void };
  private registered = new Map<string, string>();
  private closed = false;
  private mutex: Mutex;
  constructor(private helper: string, private settings: Settings = defaultSettings) {
    this.mutex = new Mutex(settings.fileQueueLimit);
  }
  private reset(error: Error) {
    const child = this.child; this.child = undefined;
    this.registered.clear();
    const pending = this.pending; this.pending = undefined;
    pending?.reject(error); child?.kill("SIGKILL");
  }
  private worker() {
    if (this.closed) throw new AppError("UNAVAILABLE", "The file service is closed");
    if (this.child) return this.child;
    const child = spawn("python3", ["-u", this.helper], { stdio: "pipe" });
    this.child = child;
    const fail = (error: Error) => { if (this.child === child) this.reset(error); };
    child.on("error", fail); child.stdin.on("error", fail);
    child.on("exit", () => fail(new AppError("UNAVAILABLE", "The file service stopped. Refresh to reconnect; check files before retrying an edit.", { outcomeUnknown: true })));
    child.stderr.on("data", data => log({ level: "warning", source: "file-worker", event: "stderr", fields: { bytes: data.length } }));
    let chunks: Buffer[] = [], bytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.child !== child) return;
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const piece = chunk.subarray(offset, newline < 0 ? chunk.length : newline);
        chunks.push(piece); bytes += piece.length;
        if (bytes > 16 * 1024 * 1024) { fail(new AppError("IO_ERROR", "File service response exceeded its byte budget", { outcomeUnknown: true })); return; }
        if (newline < 0) break;
        try {
          const response = workerResponseSchema.parse(JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")));
          const item = this.pending;
          if (!item || response.id !== item.id || response.correlationId !== item.correlationId) throw new Error("Mismatched file response");
          this.pending = undefined;
          if (response.ok) item.resolve(response.result);
          else item.reject(new AppError(response.error.code, response.error.message, response.error));
        } catch { fail(new AppError("IO_ERROR", "Invalid file service response", { outcomeUnknown: true })); return; }
        chunks = []; bytes = 0; offset = newline + 1;
      }
    });
    return child;
  }
  private async request<A extends WorkerAction>(action: A, payload: object, signal: AbortSignal, correlationId: string): Promise<FileResults[A]> {
    if (signal.aborted) throw signal.reason;
    const child = this.worker(), id = ++this.sequence;
    const abort = () => this.reset(signal.reason instanceof Error ? signal.reason : new AppError("CANCELLED", "File operation cancelled", { outcomeUnknown: true }));
    signal.addEventListener("abort", abort, { once: true });
    try {
      const value = await new Promise<unknown>((resolve, reject) => {
        this.pending = { id, correlationId, resolve, reject };
        child.stdin.write(JSON.stringify({ ...payload, action, apiVersion: 2, id, correlationId }) + "\n", error => { if (error && this.child === child) this.reset(error); });
      });
      const result = resultSchemas[action].safeParse(value);
      if (!result.success) {
        const error = new AppError("IO_ERROR", "File service returned an invalid payload", { outcomeUnknown: ["write", "move", "delete", "create"].includes(action) });
        this.reset(error); throw error;
      }
      return result.data as FileResults[A];
    } finally { signal.removeEventListener("abort", abort); }
  }
  private async operation<T>(action: string, options: FileOperationOptions, run: (signal: AbortSignal, correlationId: string) => Promise<T>) {
    const controller = new AbortController();
    let started = false;
    const uncertain = () => started && ["write", "move", "delete", "create"].includes(action);
    const correlationId = options.correlationId ?? randomUUID();
    const cancel = () => controller.abort(new AppError("CANCELLED", "File operation cancelled; refresh before retrying changes", { correlationId, outcomeUnknown: uncertain() }));
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", `File operation exceeded ${this.settings.fileTimeoutMs} ms`, { correlationId, retryable: !uncertain(), outcomeUnknown: uncertain() })), this.settings.fileTimeoutMs);
    try { return await this.mutex.run(() => { started = true; return run(controller.signal, correlationId); }, controller.signal); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw error; }
    finally { clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); }
  }
  private async bind(sessionId: string, directory: string, identity: string | undefined, signal: AbortSignal, correlationId: string) {
    const result = await this.request("register", { sessionId, directory, identity }, signal, correlationId);
    this.registered.set(sessionId, result.identity); return result;
  }
  register(sessionId: string, directory: string, identity?: string, options: FileOperationOptions = {}) {
    return this.operation("register", options, (signal, correlationId) => this.bind(sessionId, directory, identity, signal, correlationId));
  }
  run<A extends FileAction | DirectoryAction>(session: SessionRecord, request: A, options: FileOperationOptions = {}): Promise<FileResults[A["action"]]> {
    if (request.action === "directory") directoryActionSchema.parse(request); else fileActionSchema.parse(request);
    return this.operation(request.action, options, async (signal, correlationId) => {
      this.worker();
      if (this.registered.get(session.id) !== session.identity) await this.bind(session.id, session.directory, session.identity, signal, correlationId);
      return this.request<A["action"]>(request.action, { ...request, sessionId: session.id }, signal, correlationId);
    });
  }
  unregister(sessionId: string) {
    return this.operation("unregister", {}, async (signal, correlationId) => {
      this.registered.delete(sessionId); await this.request("unregister", { sessionId }, signal, correlationId);
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    // Grab a reference to the current child before `reset()` nulls it,
    // so we can await the subprocess's exit below.
    const child = this.child;
    this.reset(new AppError("CANCELLED", "The file service is closing", { outcomeUnknown: true }));
    // Wait for the helper subprocess to fully release its open file
    // descriptors before we return. Without this, a caller that follows
    // `close()` with `rm(workspaceDir, { recursive: true })` can race
    // against the kernel and hit ENOTEMPTY (or, on slower runners,
    // ENOENT on a half-removed parent in a follow-up write). SIGKILL
    // is asynchronous: the child is dead but its fds are still held
    // until the kernel reaps it.
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) { resolve(); return; }
        child.once("exit", () => resolve());
        // Safety net in case the child never reaches its `exit` handler
        // for some reason (e.g. zombie that the parent never reaped).
        setTimeout(resolve, 1000).unref();
      });
    }
  }
}
