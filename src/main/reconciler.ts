import type { EngineAdapter, ProcessInfo } from "../shared/engine";
import type { DomainEventInput } from "../shared/events";
import type { Snapshot, TerminalView } from "../shared/types";
import { asFailure, type Failure } from "../shared/errors";
import { EventBus } from "./event-bus";
import { WorkspaceState } from "./workspace-state";

export class Reconciler {
  private sequence = 0;
  private generation = 0;
  private pending?: { generation: number; promise: Promise<void> };
  private processes = new Map<string, ProcessInfo>();
  private signatures = new Map<string, string>();
  private failure?: Failure;
  private prompts = new Set<string>();
  constructor(private state: WorkspaceState, private engine: EngineAdapter, private events: EventBus) {}
  invalidate() { this.generation++; }
  prompt(id: string, ready: boolean) { if (ready) this.prompts.add(id); else this.prompts.delete(id); }
  private status(terminal: { id: string; deleting?: boolean; launchState?: string }): TerminalView["status"] {
    const live = this.processes.get(terminal.id);
    return terminal.deleting ? "deleting" : this.failure ? "unknown" : !live
      ? terminal.launchState === "starting" ? "starting" : "missing"
      : live.dead ? "exited" : this.prompts.has(terminal.id) ? "prompting" : "running";
  }
  private async refresh(generation: number) {
    let processes: Map<string, ProcessInfo>;
    try { processes = await this.engine.inspect(); }
    catch (error) {
      if (generation !== this.generation) return;
      const failure = asFailure(error, "engine");
      if (this.failure?.message !== failure.message) await this.events.publish({ type: "operation-failed", sourceId: "engine", data: failure, correlationId: failure.correlationId });
      this.failure = failure;
      return;
    }
    if (generation !== this.generation) return;
    this.processes = processes;
    if (this.failure) await this.events.publish({ type: "engine-restored", sourceId: "engine", data: {} });
    this.failure = undefined;
    const changes = this.state.read().sessions.flatMap(s => s.terminals).filter(terminal => {
      const live = processes.get(terminal.id);
      return live && ((!terminal.startedAt) || (live.dead && (terminal.endedAt !== live.endedAt || terminal.exitCode !== live.exitCode || terminal.exitSignal !== live.exitSignal)));
    });
    if (changes.length) await this.state.update(state => {
      const ids = new Set(changes.map(terminal => terminal.id));
      for (const terminal of state.sessions.flatMap(s => s.terminals)) if (ids.has(terminal.id)) {
        const live = processes.get(terminal.id)!;
        terminal.startedAt ??= new Date().toISOString();
        if (live.dead) {
          terminal.endedAt = live.endedAt;
          terminal.exitCode = live.exitCode;
          terminal.exitSignal = live.exitSignal;
        }
      }
    });
    const events: DomainEventInput[] = [];
    const signatures = new Map<string, string>();
    for (const session of this.state.read().sessions) for (const terminal of session.terminals) {
      const live = this.processes.get(terminal.id);
      const data = { status: this.status(terminal), exitCode: live?.exitCode ?? terminal.exitCode, exitSignal: live?.exitSignal ?? terminal.exitSignal };
      const signature = JSON.stringify(data); signatures.set(terminal.id, signature);
      if (this.signatures.get(terminal.id) !== signature) events.push({ type: "terminal-status", sourceId: "engine", sessionId: session.id, terminalId: terminal.id, originHookId: terminal.originHookId, data });
    }
    await this.events.publishMany(events);
    this.signatures = signatures;
  }
  async snapshot(): Promise<Snapshot> {
    const sequence = ++this.sequence;
    if (!this.pending || this.pending.generation !== this.generation) {
      const pending = { generation: this.generation, promise: this.refresh(this.generation) };
      this.pending = pending;
      void pending.promise.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => {});
    }
    await this.pending.promise;
    const state = this.state.read();
    return { sequence, presets: state.presets, envProfiles: state.envProfiles, hooks: state.hooks, launches: state.launches,
      engineError: this.failure?.message, engineFailure: this.failure,
      sessions: state.sessions.map(session => ({ ...session, terminals: session.terminals.map(terminal => {
        const live = this.processes.get(terminal.id);
        return { ...terminal, status: this.status(terminal), pid: live?.pid, process: live?.process, currentDirectory: live?.cwd,
          exitCode: live?.exitCode ?? terminal.exitCode, exitSignal: live?.exitSignal ?? terminal.exitSignal };
      }) })) };
  }
}
