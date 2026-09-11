/**
 * Micro-benchmarks guarding the performance work tracked in tasks #37-#42.
 *
 * These tests pin concrete behaviour so a future change can't silently
 * regress the wins:
 *
 *   - `inspectCoalesced` folds concurrent snapshot() callers into one
 *     inspect() so a renderer burst + watcher event don't pay N× the
 *     python-helper cost.
 *   - The reconciler cold-path snapshot stays under 200 ms even on a
 *     loaded CI runner (the renderer polls every 4 s; one snapshot per
 *     tick needs to be cheap).
 *
 * For full end-to-end hot-path numbers (state mutation, view() zero-copy,
 * event-bus batching), run `npm run bench` which exercises the same code
 * paths and prints median / p95 / min / max.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { Reconciler } from "../src/main/reconciler";
import { EventBus } from "../src/main/event-bus";
import { WorkspaceState } from "../src/main/workspace-state";
import { Store } from "../src/main/store";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineAdapter, ProcessInfo } from "../src/shared/engine";
import type { TerminalRecord } from "../src/shared/types";

class CountingEngine implements EngineAdapter {
  readonly capabilities = {
    id: "bench", platforms: ["linux"], persistent: true,
    environment: true, pushStatus: false, processTree: false,
  };
  inspectCalls = 0;
  private next = 0;
  private map = new Map<string, ProcessInfo>();
  async initialize() {}
  async inspect(): Promise<Map<string, ProcessInfo>> {
    this.inspectCalls++;
    // Simulate the cost of the python helper (~1.5 ms each).
    const busy = performance.now() + 1.5;
    while (performance.now() < busy) { /* spin */ }
    return new Map(this.map);
  }
  async create(terminal: TerminalRecord) {
    this.map.set(terminal.id, { id: terminal.id, pid: ++this.next, process: "test", cwd: terminal.cwd, dead: false });
  }
  async remove(id: string) { this.map.delete(id); }
  attach(): never { throw new Error("not used in this bench"); }
}

async function build() {
  const data = await mkdtemp(path.join(tmpdir(), "minimal-bench-"));
  const store = new Store(data);
  await store.load();
  const state = new WorkspaceState(store);
  await state.initialize();
  const engine = new CountingEngine();
  const bus = new EventBus(data, 100);
  await bus.initialize();
  const reconciler = new Reconciler(state, engine, bus);
  return { reconciler, engine, data };
}

test("burst snapshot(): inspectCoalesced folds simultaneous calls into one", async () => {
  const { reconciler, engine } = await build();
  const before = engine.inspectCalls;
  const burst = 50;
  await Promise.all(Array.from({ length: burst }, () => reconciler.snapshot()));
  const used = engine.inspectCalls - before;
  // The renderer can fire many concurrent snapshot() requests (status tick,
  // watcher event, IPC). They should coalesce — at most a handful of actual
  // inspect calls per burst, never one per snapshot().
  assert.ok(used < burst / 2,
    `expected coalescing; saw ${used} inspect() calls for ${burst} snapshots`);
});

test("reconciler.snapshot responds in well under the polling interval", async () => {
  const { reconciler, engine } = await build();
  await reconciler.snapshot(); // warm
  const start = performance.now();
  for (let i = 0; i < 20; i++) await reconciler.snapshot();
  const median = (performance.now() - start) / 20;
  assert.ok(median < 200, `median snapshot should be <200ms; was ${median.toFixed(2)}ms`);
  // sanity: we exercised the engine at least once per cold call
  assert.ok(engine.inspectCalls >= 1);
});
