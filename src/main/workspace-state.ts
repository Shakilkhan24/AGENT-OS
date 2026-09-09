import type { SessionRecord, State, TerminalRecord } from "../shared/types";
import { AppError } from "../shared/errors";
import { Store } from "./store";
import { Mutex } from "./mutex";

/** Only JSON commits share a queue. Engine and filesystem effects run outside it. */
export class WorkspaceState {
  private value!: State;
  private mutex = new Mutex();
  private terminals = new Map<string, { mutex: Mutex; users: number }>();
  constructor(readonly store: Store) {}
  async initialize() { this.value = await this.store.load(); }
  read() { return structuredClone(this.value); }
  session(id: string): SessionRecord { return findSession(this.read(), id); }
  async update<T>(mutate: (next: State) => T): Promise<T> {
    return this.mutex.run(async () => {
      const next = this.read();
      const result = mutate(next);
      if (result instanceof Promise) throw new Error("State mutations must be synchronous");
      await this.store.save(next);
      this.value = next;
      return structuredClone(result);
    });
  }
  async withTerminal<T>(id: string, action: () => Promise<T>) {
    const lock = this.terminals.get(id) ?? { mutex: new Mutex(), users: 0 };
    this.terminals.set(id, lock); lock.users++;
    try { return await lock.mutex.run(action); }
    finally { if (--lock.users === 0) this.terminals.delete(id); }
  }
}
export function findSession(state: State, id: string) {
  const session = state.sessions.find(item => item.id === id && !item.deleting);
  if (!session) throw new AppError("NOT_FOUND", "Session no longer exists");
  return session;
}
export function findTerminal(state: State, sessionId: string, id: string): TerminalRecord {
  const terminal = findSession(state, sessionId).terminals.find(item => item.id === id && !item.deleting);
  if (!terminal) throw new AppError("NOT_FOUND", "Terminal no longer exists");
  return terminal;
}
