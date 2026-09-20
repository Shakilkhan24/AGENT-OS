import path from "node:path";
import { z } from "zod";
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
import { openManagedDatabase, type OwnedDb } from "./db-owner";
import { buildManagedProjection } from "./managed-projection";
import { verifyOnce } from "./orchestration/verifier-execute";
import { acceptReview, rejectReview } from "./db/reviews";
import { transitionAttention, snoozeAttention } from "./db/attention-items";
import { previewArtifact } from "./db/artifact-references";
import { renderCandidateDiff } from "./db/candidate-diff";
import { readTaskPromptDraft, saveTaskPromptDraft, removeTaskPromptDraft } from "./db/task-prompts";
import {
  answerAttention,
  continueInvocation,
  newAttempt,
  requestRunStop,
} from "./orchestration/managed-actions";

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
  /** M3c.1 — owned DB worker for M3a/M3b entities. Closed in `close()`. */
  private readonly ownedDb: OwnedDb;
  constructor(readonly service: SessionService, private drafts: DraftStore, readonly settings: Settings,
    private recovery: string | null, private appVersion: string, ownedDb: OwnedDb) {
    this.ownedDb = ownedDb;
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
  /** The M3a/M3b worker for callers that need read or write access (e.g. tests). */
  get dbWorker() { return this.ownedDb.worker; }
  static async open(directory: string, helpers: string, appVersion: string) {
    const settings = await new SettingsStore(directory).load();
    const store = new Store(directory);
    const files = new SessionFilesystem(path.join(helpers, "filesystem.py"), settings);
    const engine = new TmuxEngine(directory, path.join(helpers, "pty_bridge.py"), settings);
    const service = new SessionService(store, engine, files, settings);
    const ownedDb = await openManagedDatabase(directory, path.join(directory, "runtime"));
    try {
      await service.initialize();
      const workspace = new RuntimeWorkspace(service, new DraftStore(directory, settings.draftLimit), settings, store.recoveredFromInvalid ?? null, appVersion, ownedDb);
      service.start(); return workspace;
    } catch (error) {
      await ownedDb.close().catch(() => {});
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
    dispatcher.register("hello", () => ({ apiVersion: API_VERSION, appVersion: this.appVersion, incarnation: this.incarnation } as const));
    dispatcher.register("snapshot", async () => ({
      ...(await service.snapshot()),
      managed: await buildManagedProjection(this.ownedDb.worker),
    }));
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
    // M3c.2 — verifier executor + review decisions. The verifier is a
    // one-shot `spawn` over the recipe/override, not a provider-bound
    // `executeOnce`. A `conflict` return is a regular IPC response, not
    // a thrown `AppError`, so the renderer can surface the human reason.
    dispatcher.register("execute-verification", async ([taskId, recipeId, override]) => {
      const worker = this.ownedDb.worker;
      try {
        const input: { taskId: string; recipeId?: string; command?: string; argv?: string[]; env?: Record<string, string>; deadlineAt: string } = {
          taskId,
          deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        };
        if (recipeId) input.recipeId = recipeId;
        else if (override) {
          input.command = override.command;
          if (override.argv) input.argv = override.argv;
          if (override.env) input.env = override.env;
        }
        const result = await verifyOnce(worker, input);
        if (result.kind === "ok") return { kind: "ok" as const, verificationId: result.verificationId, reviewId: result.reviewId };
        return { kind: "conflict" as const, reason: result.reason };
      } catch (error) {
        // Zod refinement errors and `AppError("CONFLICT"|"NOT_FOUND")` from
        // the executor surface as a structured conflict so the renderer
        // doesn't have to parse `AppError` shape itself.
        if (error instanceof AppError) return { kind: "conflict" as const, reason: error.message };
        if (error instanceof z.ZodError) {
          const first = error.issues[0]?.message ?? "invalid input";
          return { kind: "conflict" as const, reason: first };
        }
        throw error;
      }
    });
    dispatcher.register("record-review-decision", async ([reviewId, decision, decidedBy]) => {
      const worker = this.ownedDb.worker;
      try {
        const review = decision === "accept"
          ? await acceptReview(worker, reviewId, { decidedBy })
          : await rejectReview(worker, reviewId, { decidedBy });
        return { kind: "ok" as const, reviewId: review.id, status: review.status };
      } catch (error) {
        if (error instanceof AppError) return { kind: "conflict" as const, reason: error.message };
        throw error;
      }
    });
    // M3c.3 — persistent attention inbox + bounded artifact previews.
    // The renderer never has to issue two calls; `snooze-attention`
    // widens `new → seen` internally so the FSM path stays single-step.
    // All three surface `AppError` as a structured conflict so the
    // renderer surfaces a human reason without parsing `Failure` shape.
    dispatcher.register("transition-attention", async ([id, to]) => {
      const worker = this.ownedDb.worker;
      try {
        const item = await transitionAttention(worker, id, to);
        return {
          id: item.id, taskId: item.taskId, kind: item.kind,
          issueIdentity: item.issueIdentity, revision: item.revision,
          state: item.state, payloadJson: item.payloadJson,
          snoozedUntil: item.snoozedUntil,
          createdAt: item.createdAt, updatedAt: item.updatedAt,
        };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("snooze-attention", async ([id, until]) => {
      const worker = this.ownedDb.worker;
      try {
        const item = await snoozeAttention(worker, { id, until: new Date(until) });
        return {
          id: item.id, taskId: item.taskId, kind: item.kind,
          issueIdentity: item.issueIdentity, revision: item.revision,
          state: item.state, payloadJson: item.payloadJson,
          snoozedUntil: item.snoozedUntil,
          createdAt: item.createdAt, updatedAt: item.updatedAt,
        };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("preview-artifact", async ([id, principal, scopeJson]) => {
      const worker = this.ownedDb.worker;
      try {
        const preview = await previewArtifact(worker, { id, principal, scopeJson });
        return {
          id: preview.id, sha256: preview.sha256, mime: preview.mime,
          bytes: preview.bytes, truncated: preview.truncated,
          truncatedBase64Content: preview.truncatedBase64Content,
        };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    // M3c.4 — diff/artifact view. The runtime shells out to `git diff`
    // inside the run's worktree (cap = 256 KiB) and returns the
    // bounded unified diff. `AppError` becomes a structured conflict
    // so the renderer surfaces a human reason without parsing
    // `Failure` shape — same wrapping as the M3c.3 handlers.
    dispatcher.register("render-candidate-diff", async ([runId]) => {
      const worker = this.ownedDb.worker;
      try {
        const diff = await renderCandidateDiff(worker, { runId });
        return {
          runId: diff.runId, base: diff.base, tree: diff.tree,
          bytes: diff.bytes, truncated: diff.truncated, body: diff.body,
        };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    // M3c.5 — task-prompt drafts (meta-backed) + four managed-work
    // actions. The drafts follow the same conflict-wrapping pattern
    // as the M3c.3 attention handlers. The four actions return a
    // structured `{kind: "ok"} | {kind: "conflict"}` envelope so the
    // renderer's button surfaces a human reason without parsing
    // `AppError` shape.
    dispatcher.register("read-task-prompt-draft", async ([taskId]) => {
      const worker = this.ownedDb.worker;
      try {
        return await readTaskPromptDraft(worker, taskId) ?? null;
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("save-task-prompt-draft", async ([taskId, input]) => {
      const worker = this.ownedDb.worker;
      try {
        return await saveTaskPromptDraft(worker, taskId, input);
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("remove-task-prompt-draft", async ([taskId]) => {
      const worker = this.ownedDb.worker;
      await removeTaskPromptDraft(worker, taskId);
    });
    dispatcher.register("answer-attention", async ([id, input]) => {
      const worker = this.ownedDb.worker;
      try {
        const result = await answerAttention(worker, id, input);
        const viewOf = (item: typeof result.resolvedItem) => ({
          id: item.id, taskId: item.taskId, kind: item.kind,
          issueIdentity: item.issueIdentity, revision: item.revision,
          state: item.state, payloadJson: item.payloadJson,
          snoozedUntil: item.snoozedUntil,
          createdAt: item.createdAt, updatedAt: item.updatedAt,
        });
        if (!result.followUpItem)
          throw new AppError("UNAVAILABLE", "answer-attention: follow-up row missing");
        return {
          resolved: viewOf(result.resolvedItem),
          followUp: viewOf(result.followUpItem),
        };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("continue-invocation", async ([attentionId, input]) => {
      const worker = this.ownedDb.worker;
      try {
        return await continueInvocation(worker, attentionId, input);
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("new-attempt", async ([input]) => {
      const worker = this.ownedDb.worker;
      try {
        return await newAttempt(worker, input);
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    dispatcher.register("request-stop", async ([runId, input]) => {
      const worker = this.ownedDb.worker;
      try {
        const result = await requestRunStop(worker, runId, input);
        return { runId: result.runId, status: result.status, blockedExecuteOnce: result.blockedExecuteOnce };
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
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
    // The M3a/M3b worker is owned by the workspace; release it last so
    // any in-flight reader from the projection still resolves. `close()`
    // is idempotent, so this is safe even if `open()` failed.
    await this.ownedDb.close().catch(() => {});
    const failure = [...results, ...service].find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }
}
