import type { EngineAdapter } from "../shared/engine";
import type { DomainEventInput, StopPolicy } from "../shared/events";
import { AppError, asFailure } from "../shared/errors";
import { WorkspaceState } from "./workspace-state";
import { EventBus } from "./event-bus";
import { SessionFilesystem } from "./filesystem";
import { LaunchCoordinator } from "./launch-coordinator";

export class StopCoordinator {
  constructor(private state: WorkspaceState, private engine: EngineAdapter, private events: EventBus,
    private files: SessionFilesystem, private launches: LaunchCoordinator, private changed: () => void) {}
  private async remove(sessionId: string, terminalId: string, policy: StopPolicy) {
    return this.state.withTerminal(terminalId, async () => {
      const audit: DomainEventInput[] = [];
      try {
        if (this.engine.stop) {
          const report = await this.engine.stop(terminalId, policy, async (stage, pids) => {
            await this.events.publish({ type: "stop-progress", sourceId: "stop", sessionId, terminalId, data: { policy, stage, pids } });
          });
          if (report.accountingIncomplete || report.remaining.length) audit.push({ type: "operation-failed", sourceId: "stop", sessionId, terminalId,
            data: asFailure(new Error(`Terminal removed; process accounting is incomplete (${report.remaining.length} tracked processes remain)`), "stop") });
        } else await this.engine.remove(terminalId);
        await this.state.update(state => {
          const session = state.sessions.find(s => s.id === sessionId);
          if (session) session.terminals = session.terminals.filter(t => t.id !== terminalId);
        });
        this.changed();
      } catch (error) {
        audit.push({ type: "operation-failed", sourceId: "stop", sessionId, terminalId, data: asFailure(error, "stop") });
        throw error;
      } finally { await this.events.publishMany(audit); }
    });
  }
  async terminal(sessionId: string, terminalId: string, policy: StopPolicy) {
    await this.state.update(state => {
      const terminal = state.sessions.find(s => s.id === sessionId)?.terminals.find(t => t.id === terminalId);
      if (!terminal) throw new AppError("NOT_FOUND", "Terminal no longer exists");
      terminal.deleting = true; terminal.deletionPolicy = policy;
    });
    await this.remove(sessionId, terminalId, policy);
  }
  async session(id: string, policy: StopPolicy) {
    await this.state.update(state => {
      const session = state.sessions.find(s => s.id === id);
      if (!session) throw new AppError("NOT_FOUND", "Session no longer exists");
      session.deleting = true; session.deletionPolicy = policy;
    });
    this.launches.cancelSession(id);
    await this.removeSession(id, policy);
  }
  private async removeSession(id: string, policy: StopPolicy) {
    const terminals = this.state.read().sessions.find(s => s.id === id)?.terminals ?? [];
    for (let offset = 0; offset < terminals.length; offset += 4) {
      const results = await Promise.allSettled(terminals.slice(offset, offset + 4).map(t => this.remove(id, t.id, policy)));
      const rejected = results.find(result => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
    }
    await this.state.update(state => { state.sessions = state.sessions.filter(s => s.id !== id); });
    await this.files.unregister(id);
    await this.events.publish({ type: "session-changed", sourceId: "sessions", sessionId: id, data: { action: "deleted" } });
  }
  async recover() {
    for (const session of this.state.read().sessions) {
      if (session.deleting) await this.removeSession(session.id, session.deletionPolicy ?? "force");
      else for (const terminal of session.terminals) if (terminal.deleting) await this.remove(session.id, terminal.id, terminal.deletionPolicy ?? "force");
    }
  }
}
