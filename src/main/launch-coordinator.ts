import { createHash, randomUUID } from "node:crypto";
import type { EngineAdapter } from "../shared/engine";
import type { LaunchRequest, TerminalRecord } from "../shared/types";
import type { LaunchRecord } from "../shared/models";
import { launchSchema } from "../shared/launch";
import { resolveEnvironment } from "../shared/env-profiles";
import { AppError, asFailure } from "../shared/errors";
import { commandLabel } from "../shared/commands";
import { WorkspaceState, findSession } from "./workspace-state";
import { SessionFilesystem } from "./filesystem";
import { EventBus } from "./event-bus";
import { Mutex } from "./mutex";
import { log } from "./logging";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export class LaunchCoordinator {
  private active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  private queue = new Mutex(64);
  private closed = false;
  constructor(private repository: WorkspaceState, private engine: EngineAdapter, private files: SessionFilesystem,
    private events: EventBus, private changed: () => void, private ttlMs = 24 * 60 * 60 * 1000) {}
  get(id: string) {
    const record = this.repository.read().launches.find(item => item.id === id);
    if (!record) throw new AppError("NOT_FOUND", "Launch no longer exists");
    return record;
  }
  async recover() {
    if (!this.repository.read().launches.some(record => ["queued", "running"].includes(record.state))) return;
    await this.repository.update(state => {
      for (const record of state.launches) if (["queued", "running"].includes(record.state)) {
        record.state = "cancelled";
        for (const terminal of state.sessions.flatMap(s => s.terminals)) if (record.terminalIds.includes(terminal.id) && terminal.launchState === "starting") {
          terminal.launchState = "cancelled";
          terminal.launchError = "Launch interrupted. Reconnect if the process started; commands are never replayed automatically.";
        }
      }
    });
  }
  private async progress(record: LaunchRecord) {
    await this.events.publish({ type: "launch-progress", sourceId: "launch", sessionId: record.sessionId,
      correlationId: record.id, data: { launchId: record.id, completed: record.completed, total: record.terminalIds.length, state: record.state } });
  }
  async begin(sessionId: string, request: LaunchRequest): Promise<LaunchRecord> {
    if (this.closed) throw new AppError("UNAVAILABLE", "The workspace is closing");
    const options = launchSchema.parse(request);
    const fingerprint = createHash("sha256").update(canonical(options)).digest("hex");
    const previous = this.repository.read().launches.find(item => item.sessionId === sessionId && item.key === options.idempotencyKey && item.expiresAt > Date.now() && options.idempotencyKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new AppError("CONFLICT", "This launch key was already used with different options");
      return previous;
    }
    if (this.active.size >= 64) throw new AppError("BUSY", "The launch queue is full");
    const session = this.repository.session(sessionId);
    const cwd: string = await this.files.run(session, { action: "directory", path: options.cwd });
    let created = false;
    const record = await this.repository.update(state => {
      const duplicate = state.launches.find(item => item.sessionId === sessionId && options.idempotencyKey && item.key === options.idempotencyKey && item.expiresAt > Date.now());
      if (duplicate) {
        if (duplicate.fingerprint !== fingerprint) throw new AppError("CONFLICT", "This launch key was already used with different options");
        return duplicate;
      }
      const target = findSession(state, sessionId);
      if (target.terminals.length + options.count > 128) throw new AppError("BUSY", "A session can contain at most 128 terminals");
      const preset = state.presets.find(p => p.id === options.presetId);
      if (options.presetId && !preset) throw new AppError("NOT_FOUND", "Choose an existing preset");
      const command = options.command ?? preset!.command;
      const profile = state.envProfiles.find(item => item.id === options.envProfileId);
      if (options.envProfileId && !profile) throw new AppError("NOT_FOUND", "Choose an existing environment profile");
      const env = resolveEnvironment({}, profile, options.env);
      const used = new Set(target.terminals.map(item => item.label));
      const base = (options.label || (options.command === undefined ? preset?.name : undefined) || commandLabel(command)).slice(0, 70);
      let suffix = 1;
      const terminals: TerminalRecord[] = Array.from({ length: options.count }, () => {
        while (used.has(`${base} ${suffix}`)) suffix++;
        const label = `${base} ${suffix++}`; used.add(label);
        return { id: randomUUID(), label, command, cwd, createdAt: new Date().toISOString(), launchState: "starting",
          env, envProfileId: options.envProfileId, promptAnchors: options.promptAnchors, metadata: options.metadata, originHookId: options.originHookId };
      });
      target.terminals.push(...terminals);
      if (options.savePresetAs && !state.presets.some(p => p.name === options.savePresetAs && p.command === command)) {
        if (state.presets.length >= 100) throw new AppError("BUSY", "Remove an unused preset before saving another");
        state.presets.push({ id: randomUUID(), name: options.savePresetAs, command });
      }
      state.launches = state.launches.filter(item => item.expiresAt > Date.now() || this.active.has(item.id));
      if (state.launches.length >= 1000) throw new AppError("BUSY", "Launch history is full; wait for older idempotency keys to expire");
      const record: LaunchRecord = { id: randomUUID(), sessionId, key: options.idempotencyKey, fingerprint,
        expiresAt: Date.now() + this.ttlMs, terminalIds: terminals.map(t => t.id), state: "queued", completed: 0, errors: [] };
      state.launches.push(record); created = true;
      return record;
    });
    if (created) {
      const controller = new AbortController();
      // Register before the worker gets a turn, so cancellation/deduplication observes it.
      const promise = Promise.resolve().then(() => this.queue.run(() => this.run(record.id, controller.signal)));
      this.active.set(record.id, { controller, promise });
      void promise.catch(error => {
        log({ level: "error", source: "launch", event: "batch-failed", correlationId: record.id, fields: { kind: error instanceof Error ? error.name : "unknown" } });
      }).finally(() => this.active.delete(record.id));
    }
    return record;
  }
  private async run(id: string, signal: AbortSignal) {
    let record = this.get(id);
    await this.progress(record);
    for (const terminalId of record.terminalIds) {
      if (signal.aborted) break;
      await this.repository.withTerminal(terminalId, async () => {
        const terminal = this.repository.read().sessions.find(s => s.id === record.sessionId && !s.deleting)?.terminals.find(t => t.id === terminalId && !t.deleting);
        if (!terminal || signal.aborted) return;
        let failure: string | undefined;
        try { await this.engine.create(terminal); }
        catch (error) {
          const structured = asFailure(error, "launch", id); failure = structured.message;
          await this.events.publish({ type: "operation-failed", sourceId: "launch", sessionId: record.sessionId, terminalId, correlationId: id, data: structured });
        }
        record = await this.repository.update(state => {
          const current = state.sessions.find(s => s.id === record.sessionId)?.terminals.find(t => t.id === terminalId);
          if (current) {
            current.launchState = failure ? "failed" : "running";
            current.launchError = failure;
            if (!failure) current.startedAt = new Date().toISOString();
          }
          const launch = state.launches.find(item => item.id === id)!;
          launch.completed++; launch.state = "running";
          if (failure) launch.errors.push({ terminalId, error: failure });
          return launch;
        });
        this.changed();
        await this.progress(record);
      });
    }
    record = await this.repository.update(state => {
      const current = state.launches.find(item => item.id === id)!;
      current.state = signal.aborted || current.completed < current.terminalIds.length ? "cancelled" : "completed";
      for (const terminal of state.sessions.flatMap(s => s.terminals)) if (current.terminalIds.includes(terminal.id) && terminal.launchState === "starting") {
        terminal.launchState = "cancelled"; terminal.launchError = "Cancelled before this terminal was started";
      }
      return current;
    });
    this.changed(); await this.progress(record);
  }
  async wait(id: string) { await this.active.get(id)?.promise; return this.get(id); }
  cancel(id: string) { const record = this.get(id); this.active.get(id)?.controller.abort(); return record; }
  cancelSession(id: string) { for (const record of this.repository.read().launches) if (record.sessionId === id) this.active.get(record.id)?.controller.abort(); }
  close() { this.closed = true; for (const value of this.active.values()) value.controller.abort(); }
}
