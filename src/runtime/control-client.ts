import { createConnection } from "node:net";
import { AppError } from "../shared/errors";
import { API_VERSION, MAX_FRAME_BYTES, methods, checkVersion, parseRequest, parseResult, parseSignal,
  type Method, type InputArgs, type Result, type Request, type Response } from "../shared/protocol";
import { AUTH_FRAME_BYTES, welcomeSchema, serverMessageSchema,
  type RuntimeCredential, type ServerSignal, type ClientSignal } from "../shared/runtime-protocol";
import { FrameConnection } from "./connection";

type Pending = { resolve: (value: Response) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
/** No reconnect/replay of a request: disconnect can leave a mutation's outcome unknown. */
export class ControlClient {
  private connection: FrameConnection;
  private pending = new Map<string, Pending>();
  private authenticated = false;
  readonly ready: Promise<{ incarnation: string; appVersion: string }>;
  constructor(socketPath: string, credential: RuntimeCredential,
    private changed: (message: ServerSignal) => void = () => {}, private disconnected: (error: Error) => void = () => {}, authMs = 3000) {
    const socket = createConnection(socketPath);
    let resolve!: (value: { incarnation: string; appVersion: string }) => void;
    let reject!: (error: Error) => void;
    this.ready = new Promise((done, failed) => { resolve = done; reject = failed; });
    void this.ready.catch(() => {});
    const timer = setTimeout(() => this.connection.destroy(new AppError("TIMEOUT", "Runtime handshake timed out")), authMs);
    this.connection = new FrameConnection(socket, value => {
      if (!this.authenticated) {
        const welcome = welcomeSchema.parse(value); checkVersion(welcome.apiVersion);
        if (!welcome.ok) throw new AppError(welcome.error.code, welcome.error.message, welcome.error);
        this.authenticated = true; clearTimeout(timer);
        resolve({ incarnation: welcome.incarnation, appVersion: welcome.appVersion }); return;
      }
      const message = serverMessageSchema.parse(value);
      if (message.type === "signal") { parseSignal(message.name, message.envelope); this.changed(message); return; }
      checkVersion(message.response.apiVersion);
      const pending = this.pending.get(message.response.id);
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.response.id); pending.resolve(message.response); }
    }, error => {
      clearTimeout(timer); reject(error);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new AppError("UNAVAILABLE", "Runtime disconnected; refresh before retrying", { outcomeUnknown: true }));
      }
      this.pending.clear(); this.disconnected(error);
    }, () => this.authenticated ? MAX_FRAME_BYTES : AUTH_FRAME_BYTES);
    socket.once("connect", () => {
      try { this.connection.send({ type: "authenticate", apiVersion: API_VERSION, ...credential }); }
      catch (error) { this.connection.destroy(error as Error); }
    });
  }
  async dispatch(request: Request): Promise<Response> {
    await this.ready;
    parseRequest(request);
    if (this.pending.has(request.id)) throw new AppError("CONFLICT", "Request is already active");
    if (this.pending.size >= 128) throw new AppError("BUSY", "Too many pending runtime requests", { retryable: true });
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        try { this.cancel(request.id); } catch { /* The original outcome remains unknown. */ }
        reject(new AppError("TIMEOUT", "Runtime request deadline elapsed; refresh before retrying", { outcomeUnknown: true }));
      }, request.deadlineAt - Date.now());
      this.pending.set(request.id, { resolve: response => {
        try {
          if (response.ok) parseResult(request.method, methods[request.method].request.parse(request.args), response.result);
          resolve(response);
        } catch { reject(new AppError("INTERNAL", "Runtime returned an invalid response", { outcomeUnknown: true })); }
      }, reject, timer });
      try { this.connection.send({ type: "request", request }); }
      catch (error) { clearTimeout(timer); this.pending.delete(request.id); reject(error); }
    });
  }
  async call<M extends Method>(method: M, ...args: InputArgs<M>): Promise<Result<M>> {
    const request = { apiVersion: API_VERSION, id: crypto.randomUUID(), correlationId: crypto.randomUUID(),
      method, args, deadlineAt: Date.now() + methods[method].timeoutMs };
    const response = await this.dispatch(request);
    if (!response.ok) throw new AppError(response.error.code, response.error.message, response.error);
    return parseResult(method, args, response.result);
  }
  cancel(id: string) { this.connection.send({ type: "cancel", apiVersion: API_VERSION, id }); }
  signal(message: ClientSignal) { parseSignal(message.name, message.envelope); this.connection.send(message); }
  close() { this.connection.destroy(); }
}
