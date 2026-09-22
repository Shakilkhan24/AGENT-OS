import { createServer, type Server, type Socket } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { chmod, lstat } from "node:fs/promises";
import path from "node:path";
import { AppError, asFailure } from "../shared/errors";
import { API_VERSION, MAX_FRAME_BYTES, checkVersion, parseSignal, type Request, type Response } from "../shared/protocol";
import { AUTH_FRAME_BYTES, authenticationSchema, clientMessageSchema,
  type RuntimeCredential, type RuntimePeer, type ClientSignal, type ServerSignal } from "../shared/runtime-protocol";
import { log } from "../main/logging";
import { FrameConnection } from "./connection";

export interface RuntimeEndpoint {
  dispatch(request: Request): Promise<Response>;
  cancel(id: string): void;
  signal(message: ClientSignal): void;
  detachView(): void;
  /** Detach this observer and drain accepted operations; do not stop its jobs. */
  close(): Promise<void>;
}
type EndpointFactory = (peer: RuntimePeer, send: (message: ServerSignal) => void) => RuntimeEndpoint;

/** Local desktop connections only. The caller must hold the profile lock before listening. */
export class ControlServer {
  private server: Server;
  private peers = new Map<FrameConnection, Promise<void>>();
  private stopping = false;
  private drainFailure?: Error;
  constructor(private credential: RuntimeCredential, readonly incarnation: string, private appVersion: string,
    private factory: EndpointFactory, private maxPeers = 8, private authMs = 3000) {
    this.server = createServer(socket => this.accept(socket));
    this.server.on("error", error => {
      log({ level: "error", source: "runtime-transport", event: "listener-failed", fields: { kind: error.name } });
    });
  }
  async listen(socketPath: string) {
    // Never unlink a socket here: only the owner lock holder can decide it is stale.
    const directory = await lstat(path.dirname(socketPath));
    if (!directory.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o077))
      throw new AppError("UNAVAILABLE", "Runtime socket directory is not private");
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { this.server.off("listening", ready); reject(error); };
      const ready = () => { this.server.off("error", failed); resolve(); };
      this.server.once("error", failed); this.server.once("listening", ready); this.server.listen(socketPath);
    });
    try { await chmod(socketPath, 0o600); }
    catch (error) { await this.close(); throw error; }
  }
  private accept(socket: Socket) {
    if (this.stopping || this.peers.size >= this.maxPeers) { socket.destroy(); return; }
    let endpoint: RuntimeEndpoint | undefined;
    let refused = false;
    let finish!: () => void;
    const drained = new Promise<void>(resolve => { finish = resolve; });
    let authTimer: ReturnType<typeof setTimeout>;
    const connection = new FrameConnection(socket, value => {
      if (refused) throw new AppError("UNAVAILABLE", "Runtime authentication was refused");
      if (!endpoint) {
        try {
          const auth = authenticationSchema.parse(value); checkVersion(auth.apiVersion);
          if (auth.profileKey !== this.credential.profileKey || !timingSafeEqual(Buffer.from(auth.token), Buffer.from(this.credential.token)))
            throw new AppError("UNAVAILABLE", "Runtime authentication failed");
          endpoint = this.factory(Object.freeze({ connectionId: crypto.randomUUID(), profileKey: auth.profileKey, principal: "desktop" }), message => {
            parseSignal(message.name, message.envelope); connection.send(message);
          });
          clearTimeout(authTimer);
          connection.send({ type: "welcome", apiVersion: API_VERSION, ok: true, incarnation: this.incarnation, appVersion: this.appVersion });
        } catch (error) {
          refused = true;
          connection.send({ type: "welcome", apiVersion: API_VERSION, ok: false, error: asFailure(error, "runtime-auth") });
          socket.end();
        }
        return;
      }
      const message = clientMessageSchema.parse(value);
      if (message.type === "cancel") { checkVersion(message.apiVersion); endpoint.cancel(message.id); }
      else if (message.type === "signal") { parseSignal(message.name, message.envelope); endpoint.signal(message); }
      else {
        void endpoint.dispatch(message.request).then(response => {
          if (!socket.destroyed) connection.send({ type: "response", response });
        }).catch(error => connection.destroy(error));
      }
    }, () => {
      clearTimeout(authTimer);
      // Keep disconnected work counted against admission until it has actually drained.
      void Promise.resolve().then(() => endpoint?.close()).catch(error => {
        this.drainFailure ??= error;
        log({ level: "error", source: "runtime-transport", event: "connection-drain-failed", fields: { code: asFailure(error).code } });
      }).finally(() => { this.peers.delete(connection); finish(); });
    }, () => endpoint ? MAX_FRAME_BYTES : AUTH_FRAME_BYTES);
    this.peers.set(connection, drained);
    authTimer = setTimeout(() => connection.destroy(new AppError("TIMEOUT", "Runtime authentication timed out")), this.authMs);
  }
  async close() {
    this.stopping = true;
    const stopped = new Promise<void>(resolve => this.server.close(() => resolve()));
    for (const connection of this.peers.keys()) connection.destroy();
    await Promise.all([stopped, ...this.peers.values()]);
    if (this.drainFailure) throw this.drainFailure;
  }
}
