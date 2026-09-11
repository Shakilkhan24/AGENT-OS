import type { SessionRecord, State, TerminalRecord } from "../shared/types";
import { AppError } from "../shared/errors";
import { Store } from "./store";
import { Mutex } from "./mutex";

/** Only JSON commits share a queue. Engine and filesystem effects run outside it. */
export class WorkspaceState {
  private value!: State;
  private cached!: Readonly<State>;
  private mutex = new Mutex();
  private terminals = new Map<string, { mutex: Mutex; users: number }>();
  constructor(readonly store: Store) {}
  async initialize() {
    this.value = await this.store.load();
    this.cached = freezeDeep(this.value);
  }
  /**
   * Deep-clone the state tree. Use this when you need to mutate the
   * returned value (via `update()`) or hand it to a caller you don't
   * trust. Cost is `O(state size)`; cache the result locally if you read
   * multiple times within one logical step.
   */
  read(): State { return structuredClone(this.value); }
  /**
   * Frozen, zero-copy view of the current state. Safe to read, share, or
   * iterate without risk of corrupting the live value — any mutation
   * attempt throws in strict mode. Prefer this over `read()` for read-only
   * code paths; the reconciler, coordinators, and snapshot builder all
   * qualify.
   */
  view(): Readonly<State> { return this.cached; }
  session(id: string): SessionRecord { return findSession(this.read(), id); }
  async update<T>(mutate: (next: State) => T): Promise<T> {
    return this.mutex.run(async () => {
      const next = this.read();
      const result = mutate(next);
      if (result instanceof Promise) throw new Error("State mutations must be synchronous");
      this.value = next;
      this.cached = freezeDeep(next);
      await this.store.save(next);
      return structuredClone(result);
    });
  }
  /**
   * Run a mutation, then wait for the on-disk journal to catch up. Use this
   * when you need to observe the change from outside the process (e.g. test
   * assertions on `state.json`, or before a restart). For in-process reads
   * the in-memory state is already updated; you only need `flush()` when
   * crossing the persistence boundary.
   */
  async commit<T>(mutate: (next: State) => T): Promise<T> {
    const result = await this.update(mutate);
    await this.store.flush();
    return result;
  }
  async withTerminal<T>(id: string, action: () => Promise<T>) {
    const lock = this.terminals.get(id) ?? { mutex: new Mutex(), users: 0 };
    this.terminals.set(id, lock); lock.users++;
    try { return await lock.mutex.run(action); }
    finally { if (--lock.users === 0) this.terminals.delete(id); }
  }
}
function freezeDeep<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) freezeDeep(value[i]);
  } else if (value && typeof value === "object") {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      freezeDeep((value as Record<string, unknown>)[key]);
    }
  }
  return Object.freeze(value);
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
