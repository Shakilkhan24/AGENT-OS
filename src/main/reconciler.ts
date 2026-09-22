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
  private inspectInflight?: { generation: number; promise: Promise<Map<string, ProcessInfo>> };
  private signatures = new Map<string, string>();
  private failure?: Failure;
  private prompts = new Set<string>();
  private refreshes = new Set<Promise<void>>();
  constructor(private state: WorkspaceState, private engine: EngineAdapter, private events: EventBus) {}
  invalidate() { this.generation++; }
  prompt(id: string, ready: boolean) { if (ready) this.prompts.add(id); else this.prompts.delete(id); }
  /** Shared, coalesced view of tmux processes. See {@link inspectCoalesced}. */
  cachedInspect(): Promise<Map<string, ProcessInfo>> { return this.inspectCoalesced(); }
  /**
   * Returns the current process map. Concurrent callers share the in-flight
   * promise so a burst of `snapshot()` calls (e.g. one from a watcher event
   * and another from an incoming IPC request a few ms later) fork the python
   * helper exactly once. No value caching: every call after the in-flight
   * one completes re-invokes the engine so failures and removals are visible
   * on the very next snapshot.
   */
  private inspectCoalesced(): Promise<Map<string, ProcessInfo>> {
    if (this.inspectInflight?.generation === this.generation) return this.inspectInflight.promise;
    const promise = this.engine.inspect().finally(() => {
      if (this.inspectInflight?.promise === promise) this.inspectInflight = undefined;
    });
    this.inspectInflight = { generation: this.generation, promise };
    return promise;
  }
  private status(terminal: { id: string; deleting?: boolean; launchState?: string }): TerminalView["status"] {
    const live = this.processes.get(terminal.id);
    return terminal.deleting ? "deleting" : this.failure ? "unknown" : !live
      ? terminal.launchState === "starting" ? "starting" : "missing"
      : live.dead ? "exited" : this.prompts.has(terminal.id) ? "prompting" : "running";
  }
  private async refresh(generation: number) {
    let processes: Map<string, ProcessInfo>;
    try { processes = await this.inspectCoalesced(); }
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
    const changes = this.state.view().sessions.flatMap(s => s.terminals).filter(terminal => {
      const live = processes.get(terminal.id);
      return live && ((!terminal.startedAt) || (live.dead && (terminal.endedAt !== live.endedAt || terminal.exitCode !== live.exitCode || terminal.exitSignal !== live.exitSignal)));
    });
    if (changes.length) await this.state.update(state => {
      const ids = new Set(changes.map(terminal => terminal.id));
      for (const terminal of state.sessions.flatMap(s => s.terminals)) if (ids.has(terminal.id)) {
        const live = processes.get(terminal.id)!;
        terminal.startedAt ??= new Date().toISOString();
        if (live.dead) {
          // Don't clobber an exit code we already recorded with `undefined`
          // if the engine's first report happens to omit it (tmux can hand
          // us `pane_dead_status=""` before the next refresh fills it in).
          if (live.endedAt !== undefined) terminal.endedAt = live.endedAt;
          if (live.exitCode !== undefined) terminal.exitCode = live.exitCode;
          if (live.exitSignal !== undefined) terminal.exitSignal = live.exitSignal;
        }
      }
    });
    const events: DomainEventInput[] = [];
    const signatures = new Map<string, string>();
    const view = this.state.view();
    for (const session of view.sessions) for (const terminal of session.terminals) {
      const live = this.processes.get(terminal.id);
      const data = { status: this.status(terminal), exitCode: live?.exitCode ?? terminal.exitCode, exitSignal: live?.exitSignal ?? terminal.exitSignal };
      const signature = `${data.status}|${data.exitCode ?? ""}|${data.exitSignal ?? ""}`;
      signatures.set(terminal.id, signature);
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
      this.refreshes.add(pending.promise);
      void pending.promise.finally(() => {
        this.refreshes.delete(pending.promise);
        if (this.pending === pending) this.pending = undefined;
      }).catch(() => {});
    }
    await this.pending.promise;
    // Use the frozen view for read-only consumers; the snapshot is a fresh
    // object built from it, so the renderer's identity check still works.
    const view = this.state.view();
    return { sequence, presets: view.presets, envProfiles: view.envProfiles, hooks: view.hooks, launches: view.launches,
      engineError: this.failure?.message, engineFailure: this.failure,
      sessions: view.sessions.map(session => ({ ...session, terminals: session.terminals.map(terminal => {
        const live = this.processes.get(terminal.id);
        return { ...terminal, status: this.status(terminal), pid: live?.pid, process: live?.process, currentDirectory: live?.cwd,
          exitCode: live?.exitCode ?? terminal.exitCode, exitSignal: live?.exitSignal ?? terminal.exitSignal };
      }) })) };
  }
  async drain() { await Promise.allSettled(this.refreshes); }
}
