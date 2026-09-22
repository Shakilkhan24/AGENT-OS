import { AppError, asFailure } from "../shared/errors";
import { API_VERSION, MAX_FRAME_BYTES, methods, requestSchema, parseRequest, parseResult, checkFrame,
  type Method, type RequestArgs, type Result, type Response, type InvocationContext } from "../shared/protocol";
import { utf8Bytes } from "../shared/terminal-flow";
import { log } from "./logging";

type Handler = (args: unknown[], context: InvocationContext) => Promise<unknown>;
const identitySchema = requestSchema.pick({ id: true, correlationId: true }).strip();

/** Admission and reply deadlines do not pretend a timed-out mutation was undone. */
export class ProtocolDispatcher {
  private handlers = new Map<Method, Handler>();
  private controllers = new Map<string, AbortController>();
  private pending = new Set<Promise<unknown>>();
  private closed = false;
  private pendingBytes = 0;
  constructor(private limit = 128, private byteLimit = 2 * MAX_FRAME_BYTES) {}
  register<M extends Method>(name: M, handler: (args: RequestArgs<M>, context: InvocationContext) => Result<M> | Promise<Result<M>>) {
    if (this.handlers.has(name)) throw new Error(`Duplicate method registration: ${name}`);
    this.handlers.set(name, async (args, context) => handler(methods[name].request.parse(args) as RequestArgs<M>, context));
  }
  cancel(id: string) { this.controllers.get(id)?.abort(new AppError("CANCELLED", "Request cancelled", { outcomeUnknown: true })); }
  async dispatch(channel: Method, value: unknown): Promise<Response> {
    // Recover only schema-validated identifiers for a malformed/version-mismatched request.
    const identity = identitySchema.safeParse(value);
    const id = identity.success ? identity.data.id : crypto.randomUUID();
    const correlationId = identity.success ? identity.data.correlationId : crypto.randomUUID();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const request = parseRequest(value);
      if (request.method !== channel) throw new AppError("INVALID_REQUEST", "Request method does not match its channel");
      if (this.closed) throw new AppError("UNAVAILABLE", "The workspace is closing");
      const bytes = utf8Bytes(JSON.stringify(request));
      if (this.pending.size >= this.limit || this.pendingBytes + bytes > this.byteLimit)
        throw new AppError("BUSY", "Too many pending requests", { retryable: true });
      if (this.controllers.has(id)) throw new AppError("CONFLICT", "Request is already active");
      const handler = this.handlers.get(channel);
      if (!handler) throw new AppError("UNAVAILABLE", "Operation is not available");
      const controller = new AbortController(); this.controllers.set(id, controller);
      const context = { signal: controller.signal, requestId: id, correlationId, deadlineAt: request.deadlineAt };
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      timer = setTimeout(() => controller.abort(new AppError("TIMEOUT", "Operation deadline elapsed; refresh before retrying", { outcomeUnknown: true })), request.deadlineAt - Date.now());
      const work = Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return handler(request.args, context);
      });
      this.pending.add(work);
      this.pendingBytes += bytes;
      // Keep timed-out work accounted for until it settles, including shutdown.
      void work.finally(() => { this.pending.delete(work); this.pendingBytes -= bytes; this.controllers.delete(id); }).catch(() => {});
      const output = await Promise.race([work, aborted]);
      try {
        const result = parseResult(channel, request.args as RequestArgs<Method>, output);
        const response = { apiVersion: API_VERSION, id, ok: true as const, result };
        checkFrame(response);
        return response;
      }
      catch { throw new AppError("INTERNAL", "Operation returned an invalid response; refresh before retrying", { outcomeUnknown: true }); }
    } catch (error) {
      const failure = asFailure(error, channel, correlationId);
      log({ level: "warning", source: "protocol", event: "request-failed", correlationId,
        fields: { method: channel, code: failure.code, outcomeUnknown: failure.outcomeUnknown } });
      return { apiVersion: API_VERSION, id, ok: false, error: failure };
    } finally {
      clearTimeout(timer);
    }
  }
  async close() {
    this.closed = true;
    const results = await Promise.allSettled([...this.pending]);
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
