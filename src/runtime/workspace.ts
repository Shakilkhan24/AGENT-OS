import path from "node:path";
import { API_VERSION, parseSignal } from "../shared/protocol";
import type { RuntimePeer, ServerSignal } from "../shared/runtime-protocol";
import { AppError } from "../shared/errors";
import type { Settings } from "../shared/settings";
import type { Attachment } from "../shared/engine";
import { DraftStore } from "../main/draft-store";
import { Store } from "../main/store";
import { SettingsStore } from "../main/settings-store";
import { SessionService } from "../main/service";
import { SessionFilesystem } from "../main/filesystem";
import { TmuxEngine } from "../main/engine";
import { ProtocolDispatcher } from "../main/protocol-dispatcher";
import type { RuntimeEndpoint } from "./control-server";
import { TerminalInputQueue, type InputQueueProgress } from "./input-queue";

/** Domain ownership without Electron. One selected attachment is retained until M5. */
export class RuntimeWorkspace {
  readonly incarnation = crypto.randomUUID();
  private peers = new Map<string, { send: (message: ServerSignal) => void; endpoint: RuntimeEndpoint }>();
  private attachment?: { owner: string; view: Attachment };
  private generation = 0;
  private closing = false;
  private stopped?: Promise<void>;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe: () => void;
  private readonly inputQueue: TerminalInputQueue;
  constructor(readonly service: SessionService, private drafts: DraftStore, readonly settings: Settings,
    private recovery: string | null, private appVersion: string) {
    this.inputQueue = new TerminalInputQueue(async (token, data) => {
      if (this.closing) throw new AppError("UNAVAILABLE", "Runtime is stopping");
      if (this.attachment?.view.token !== token)
        throw new AppError("CONFLICT", "Terminal selection changed; input was cancelled", { outcomeUnknown: true });
      await this.attachment.view.input(data);
    });
    this.inputQueue.onProgress(snapshot => this.broadcastInputProgress(snapshot));
    this.unsubscribe = service.events.subscribe(() => {
      if (this.changeTimer || this.closing) return;
      this.changeTimer = setTimeout(() => {
        this.changeTimer = undefined;
        for (const peer of this.peers.values()) {
          try { peer.send({ type: "signal", name: "workspace-changed", envelope: { apiVersion: API_VERSION, args: [] } }); }
          catch { /* The transport owns disconnect and admission cleanup. */ }
        }
      }, 25);
    });
  }
  static async open(directory: string, helpers: string, appVersion: string) {
    const settings = await new SettingsStore(directory).load();
    const store = new Store(directory);
    const files = new SessionFilesystem(path.join(helpers, "filesystem.py"), settings);
    const engine = new TmuxEngine(directory, path.join(helpers, "pty_bridge.py"), settings);
    const service = new SessionService(store, engine, files, settings);
    try {
      await service.initialize();
      const workspace = new RuntimeWorkspace(service, new DraftStore(directory, settings.draftLimit), settings, store.recoveredFromInvalid ?? null, appVersion);
      service.start(); return workspace;
    } catch (error) {
      await service.close().catch(() => {}); await files.close(); throw error;
    }
  }
  connect(peer: RuntimePeer, send: (message: ServerSignal) => void): RuntimeEndpoint {
    if (this.closing) throw new AppError("UNAVAILABLE", "The runtime is closing");
    if (this.peers.has(peer.connectionId)) throw new AppError("CONFLICT", "Connection already exists");
    const dispatcher = new ProtocolDispatcher();
    const service = this.service;
    let closed = false;
    let drained: Promise<void> | undefined;
    const emit = (message: ServerSignal) => {
      if (closed) return;
      try { send(message); } catch { /* A stalled socket is closed by its transport. */ }
    };
    const selected = (token: string) => {
      if (closed || this.attachment?.owner !== peer.connectionId || this.attachment.view.token !== token)
        throw new AppError("CONFLICT", "Terminal selection changed; input was cancelled");
      return this.attachment.view;
    };
    dispatcher.register("hello", () => ({ apiVersion: API_VERSION, appVersion: this.appVersion, incarnation: this.incarnation }));
    dispatcher.register("snapshot", () => service.snapshot());
    dispatcher.register("get-settings", () => this.settings);
    dispatcher.register("startup-recovery", () => this.recovery);
    dispatcher.register("list-drafts", () => this.drafts.list());
    dispatcher.register("read-draft", ([id]) => this.drafts.read(id));
    dispatcher.register("save-draft", ([input]) => { service.state.session(input.sessionId); return this.drafts.save(input); });
    dispatcher.register("remove-draft", ([id]) => this.drafts.remove(id));
    dispatcher.register("create-session", ([name, directory]) => service.createSession(name, directory));
    dispatcher.register("rename-session", ([id, name]) => service.renameSession(id, name));
    dispatcher.register("delete-session", ([id]) => service.deleteSession(id));
    dispatcher.register("create-terminals", ([sessionId, presetId, count, cwd], context) =>
      service.launchTerminals(sessionId, { presetId, count, cwd }, context.signal));
    dispatcher.register("launch-terminals", ([sessionId, request], context) => service.launchTerminals(sessionId, request, context.signal));
    dispatcher.register("rename-terminal", ([sessionId, id, label]) => service.renameTerminal(sessionId, id, label));
    dispatcher.register("delete-terminal", ([sessionId, id]) => service.deleteTerminal(sessionId, id));
    dispatcher.register("save-presets", ([presets]) => service.savePresets(presets));
    dispatcher.register("files", ([sessionId, request], context) => service.files(sessionId, request, context));
    dispatcher.register("attach", async ([id, cols, rows], context) => {
      const generation = ++this.generation;
      await service.requireTerminal(id); context.signal.throwIfAborted();
      if (closed || generation !== this.generation) throw new AppError("CONFLICT", "Terminal selection changed");
      const previous = this.attachment?.view.token;
      this.detach();
      const view = service.engine.attach(id, cols, rows,
        (token, output) => {
          emit({ type: "signal", name: "terminal-output", envelope: { apiVersion: API_VERSION, args: [token, output] } });
        }, token => {
          emit({ type: "signal", name: "terminal-exit", envelope: { apiVersion: API_VERSION, args: [token] } });
        });
      this.attachment = { owner: peer.connectionId, view };
      // Drop unsubmitted bytes from the prior attachment for this connection;
      // admitted bytes already in-flight are not promise-revocable.
      if (previous) this.inputQueue.cancel(previous);
      return view.token;
    });
    dispatcher.register("detach", ([token]) => {
      if (this.attachment?.owner === peer.connectionId && this.attachment.view.token === token) this.detach();
    });
    dispatcher.register("input", ([token, data], context) => {
      selected(token);
      context.signal.throwIfAborted();
      return this.inputQueue.enqueue(token, data);
    });
    dispatcher.register("cancel-input", ([token]) => ({ dropped: this.inputQueue.cancel(token) }));
    const endpoint: RuntimeEndpoint = {
      dispatch: request => dispatcher.dispatch(request.method, request),
      cancel: id => dispatcher.cancel(id),
      signal: message => {
        const [token, first, second] = parseSignal(message.name, message.envelope);
        // Late output credit/resize from a disposed view is harmless.
        if (closed || this.attachment?.owner !== peer.connectionId || this.attachment.view.token !== token) return;
        if (message.name === "resize") selected(token).resize(first, second!);
        else selected(token).acknowledge(first);
      },
      detachView: () => {
        if (this.attachment?.owner === peer.connectionId) this.detach();
      },
      close: () => {
        if (drained) return drained;
        closed = true;
        if (this.attachment?.owner === peer.connectionId) this.detach();
        drained = dispatcher.close().finally(() => this.peers.delete(peer.connectionId));
        return drained;
      },
    };
    this.peers.set(peer.connectionId, { send: emit, endpoint });
    return endpoint;
  }
  private detach() {
    if (!this.attachment) return;
    const token = this.attachment.view.token;
    this.attachment.view.close();
    this.attachment = undefined;
    // Drop unsubmitted bytes; admitted in-flight bytes are not promise-revocable.
    this.inputQueue.cancel(token);
  }
  private broadcastInputProgress(snapshot: InputQueueProgress[]) {
    if (snapshot.length === 0) return;
    for (const peer of this.peers.values()) {
      try { peer.send({ type: "signal", name: "terminal-input-progress", envelope: { apiVersion: API_VERSION, args: [snapshot] } }); }
      catch { /* The transport owns disconnect and admission cleanup. */ }
    }
  }
  close() { return this.stopped ??= this.shutdown(); }
  private async shutdown() {
    this.closing = true; this.unsubscribe(); clearTimeout(this.changeTimer);
    this.detach();
    // Drain admitted input before tearing the engine down — those bytes were
    // promised to the terminal even if no peer is connected anymore.
    await this.inputQueue.close();
    // Runtime stop cancels between launch items. Desktop disconnection does not.
    const clients = [...this.peers.values()];
    const results = await Promise.allSettled([this.service.launches.close(), ...clients.map(peer => peer.endpoint.close())]);
    const service = await Promise.allSettled([this.service.close()]);
    await this.service.filesystem.close();
    const failure = [...results, ...service].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
