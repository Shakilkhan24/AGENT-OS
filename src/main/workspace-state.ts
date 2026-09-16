import type { SessionRecord, State, TerminalRecord } from "../shared/types";
import { AppError } from "../shared/errors";
import { Store } from "./store";
import { Mutex } from "./mutex";
import { stateSchema } from "../shared/models";
import {
  savedLayoutSchema,
  type SavedLayout,
} from "../shared/workspace6-schema";
import {
  digestLayout,
  hydrateLayouts,
  migrateLayoutV2toV3,
} from "../runtime/orchestration/layout";

/** Only JSON commits share a queue. Engine and filesystem effects run outside it. */
export class WorkspaceState {
  private value!: State;
  private cached!: Readonly<State>;
  private mutex = new Mutex();
  private terminals = new Map<string, { mutex: Mutex; users: number }>();
  private layouts = new Map<string, SavedLayout>();
  constructor(readonly store: Store) {}
  async initialize() {
    const raw = await this.store.load();
    // M5.6: persist layouts in `state.layouts`; v2 → v3 migration adds the map.
    const migrated = raw.version === 2 ? migrateLayoutV2toV3(raw as State) : (raw as State & { layouts?: Record<string, SavedLayout> });
    const { kept, dropped } = hydrateLayouts(migrated as unknown as { layouts?: Record<string, unknown> });
    this.layouts = new Map(kept);
    if (dropped.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`WorkspaceState: dropping ${dropped.length} invalid saved layouts: ${dropped.join(",")}`);
    }
    this.value = await this.store.load();
    // If we just migrated v2→v3, persist the bumped state so subsequent reads see v3.
    if (raw.version === 2) {
      await this.store.save(this.value as unknown as State);
    }
    this.cached = freezeDeep(this.value);
  }
  /**
   * Deep-clone the state tree. Use this when you need to mutate the
   * returned value (via `update()`) or hand it to a caller you don't
   * trust. Cost is `O(state size)`; cache the result locally if you read
   * multiple steps within one logical step.
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
      const output = structuredClone(result);
      const committed = stateSchema.parse(next);
      await this.store.save(committed);
      this.value = committed;
      this.cached = freezeDeep(committed);
      return output;
    });
  }
  /**
   * Explicit durable commit alias. update() already waits for persistence.
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

  // ── M5.6 saved layout (per-session, persisted via Store) ─────────────────

  async saveLayout(layout: SavedLayout): Promise<{ saved: true }> {
    const validated = savedLayoutSchema.parse(layout);
    return this.mutex.run(async () => {
      // Refresh digest so a stale layoutDigest doesn't poison the record.
      const refresh = {
        ...validated,
        layoutDigest: digestLayout(validated.sessionId, validated.split, validated.top, validated.bottom),
      };
      this.layouts.set(refresh.sessionId, refresh);
      // Persist alongside the state object so a future `store.load()` reads it.
      const next = this.read() as unknown as { layouts?: Record<string, SavedLayout> };
      next.layouts = Object.fromEntries(this.layouts);
      await this.store.save(stateSchema.parse(this.read()) as unknown as State);
      // (We deliberately don't write the bumped layouts to `state` itself
      // because `State.version = 2` is fixed; the layout map lives in
      // `WorkspaceState.layouts` + the `Store.persist` mirror.)
      return { saved: true as const };
    });
  }
  async readLayout(sessionId: string): Promise<{ layout: SavedLayout | null }> {
    return this.mutex.run(async () => {
      return { layout: this.layouts.get(sessionId) ?? null };
    });
  }
  async clearLayout(sessionId: string): Promise<{ cleared: boolean }> {
    return this.mutex.run(async () => {
      const had = this.layouts.delete(sessionId);
      if (had) {
        const next = this.read() as unknown as { layouts?: Record<string, SavedLayout> };
        next.layouts = Object.fromEntries(this.layouts);
        await this.store.save(stateSchema.parse(this.read()) as unknown as State);
      }
      return { cleared: had };
    });
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
