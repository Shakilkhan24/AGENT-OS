/**
 * Hot-path performance harness.
 *
 * Exercises the four real-world operations the user calls out as slow:
 *   1. State persistence (`state.update` -> debounced fsync)
 *   2. Snapshot build (reconciler with frozen zero-copy view)
 *   3. Concurrent snapshot coalescing (renderer burst)
 *   4. Event-bus publishMany with debounced journal
 *
 * Reports median + p95 wall-clock per scenario so we can spot regressions.
 * Pure benchmark — never asserts, never throws on slowness. Output is meant
 * to be diffed over time and visually inspected.
 */
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Store } from "../src/main/store";
import { WorkspaceState } from "../src/main/workspace-state";
import { EventBus } from "../src/main/event-bus";
import { Reconciler } from "../src/main/reconciler";
import type { EngineAdapter, ProcessInfo } from "../src/shared/engine";
import type { TerminalRecord, State, SessionRecord } from "../src/shared/types";
import { randomUUID } from "node:crypto";

class FastEngine implements EngineAdapter {
  readonly capabilities = {
    id: "bench", platforms: ["linux"], persistent: true,
    environment: true, pushStatus: false, processTree: false,
  };
  private next = 0;
  private map = new Map<string, ProcessInfo>();
  inspectCostMs = 1.5;
  async initialize() {}
  async inspect(): Promise<Map<string, ProcessInfo>> {
    if (this.inspectCostMs) {
      const busy = performance.now() + this.inspectCostMs;
      while (performance.now() < busy) { /* spin */ }
    }
    return new Map(this.map);
  }
  async create(terminal: TerminalRecord) {
    this.map.set(terminal.id, {
      id: terminal.id, pid: ++this.next, process: "test",
      cwd: terminal.cwd, dead: false,
    });
  }
  async remove(id: string) { this.map.delete(id); }
  attach(): never { throw new Error("not used"); }
}

type Stat = { median: number; p95: number; min: number; max: number; n: number };
function stats(samples: number[]): Stat {
  const sorted = samples.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const median = sorted[Math.floor(n / 2)];
  const p95 = sorted[Math.min(n - 1, Math.floor(n * 0.95))];
  return {
    median, p95,
    min: sorted[0],
    max: sorted[n - 1],
    n,
  };
}
function fmt(ms: number) { return `${ms.toFixed(2).padStart(8)} ms`; }
function print(label: string, stat: Stat) {
  console.log(
    `${label.padEnd(50)}  ` +
    `median ${fmt(stat.median)}  p95 ${fmt(stat.p95)}  ` +
    `min ${fmt(stat.min)}  max ${fmt(stat.max)}  (n=${stat.n})`,
  );
}

async function build() {
  const data = await mkdtemp(path.join(tmpdir(), "minimal-perf-"));
  const store = new Store(data);
  await store.load();
  const state = new WorkspaceState(store);
  await state.initialize();
  const engine = new FastEngine();
  const bus = new EventBus(data, 1000);
  await bus.initialize();
  const reconciler = new Reconciler(state, engine, bus);

  // Seed a realistic workspace so update/snapshot have something to chew on.
  await state.update((next) => {
    next.sessions = Array.from({ length: 3 }, (_, s) => ({
      id: randomUUID(),
      name: `Session ${s}`,
      directory: "/tmp",
      identity: "bench",
      createdAt: new Date().toISOString(),
      deleting: false,
      terminals: Array.from({ length: 12 }, () => ({
        id: randomUUID(),
        sessionId: "",
        label: "t",
        cwd: "/tmp",
        command: "sleep 999",
        createdAt: new Date().toISOString(),
        env: {},
      })),
    } satisfies SessionRecord[]));
    for (const s of next.sessions) for (const t of s.terminals) t.sessionId = s.id;
  });
  await store.flush();

  // Provision the engine map for the seeded terminals.
  const seeded: State = state.read();
  for (const s of seeded.sessions) for (const t of s.terminals) await engine.create(t);

  return { data, store, state, engine, bus, reconciler };
}

async function scenario(label: string, fn: () => Promise<void> | void, runs: number) {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  print(label, stats(samples));
}

async function main() {
  const ctx = await build();
  const { data, state, store, reconciler, bus, engine } = ctx;
  console.log(`\nHot-path benchmark — durable state and events, no artificial debounce delay`);
  console.log(`Seed: 3 sessions × 12 terminals = 36 terminals in workspace.\n`);

  // Warm caches.
  await reconciler.snapshot();
  await bus.publishMany([]);

  console.log("--- 1. State mutation throughput (durable writer) ------------------");
  await scenario("state.update no-op (validate + persist + freeze)", async () => {
    await state.update((next) => {
      next.sessions[0].name = next.sessions[0].name;
    });
  }, 50);

  await scenario("state.update real mutation (write to disk via debounce)", async () => {
    await state.update((next) => {
      next.sessions[0].name = `tick ${performance.now()}`;
    });
  }, 50);

  await scenario("store.save + explicit flush (crossing persistence boundary)", async () => {
    await state.update((next) => { next.sessions[0].name = `flushed ${performance.now()}`; });
    await store.flush();
  }, 30);

  console.log("\n--- 2. Snapshot / read-only paths ------------------------------------");
  await scenario("state.view() (frozen, zero-copy)", () => {
    state.view();
  }, 200);

  await scenario("state.read() (deep-clone, returns mutable copy)", async () => {
    state.read();
  }, 100);

  await scenario("reconciler.snapshot() cold path (one inspect call)", async () => {
    await reconciler.snapshot();
  }, 30);

  console.log("\n--- 3. Simulated concurrent snapshot coalescing --------------------------------------");
  // Force fresh inspect each call by waiting for the in-flight promise.
  await scenario("snapshot() × 25 parallel (should fold into ~1 inspect)", async () => {
    await Promise.all(Array.from({ length: 25 }, () => reconciler.snapshot()));
  }, 30);

  console.log("\n--- 4. Event-bus publishMany -----------------------------------------");
  await scenario("publishMany([]) (no-op fast path)", async () => {
    await bus.publishMany([]);
  }, 100);

  await scenario("publishMany([evt]) single event (durable)", async () => {
    await bus.publish({ type: "engine-restored", sourceId: "engine", data: {} });
  }, 100);

  await scenario("publishMany(batch of 8) batched events", async () => {
    await bus.publishMany(Array.from({ length: 8 }, () => ({
      type: "engine-restored" as const, sourceId: "engine", data: {},
    })));
  }, 60);

  console.log("\n--- 5. Simulated lifecycle (no Electron IPC or real tmux) -------------------------------");
  await scenario("createTerminal + snapshot + flush (full lifecycle)", async () => {
    const session = state.view().sessions[0];
    await state.update((next) => {
      const s = next.sessions.find(x => x.id === session.id)!;
      s.terminals.push({
        id: randomUUID(),
        sessionId: s.id,
        label: "t",
        cwd: "/tmp",
        command: "sleep 999",
        createdAt: new Date().toISOString(),
        env: {},
      });
    });
    const last = state.view().sessions[0].terminals.at(-1)!;
    await engine.create(last as TerminalRecord);
    await reconciler.snapshot();
    await store.flush();
  }, 20);

  await bus.close();
  await store.close();
  await engine.inspect().catch(() => {});
  await rm(data, { recursive: true, force: true });
  console.log("\nDone.\n");
}

await main();
