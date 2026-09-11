/**
 * Durability guarantees for the debounced writers (`Store` and `EventBus`).
 *
 * These tests pin the contract clients rely on:
 *  - concurrent calls inside one debounce window collapse into one write
 *  - the latest scheduled args win
 *  - `flush()` is required to observe writes synchronously
 *  - `close()` is idempotent and always drains
 *  - failures inside the writer propagate to every coalesced caller
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/main/store";
import { EventBus } from "../src/main/event-bus";
import { atomicJson, type Durability } from "../src/main/atomic";
import { Debouncer } from "../src/main/debouncer";

async function tmp(dir: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `minimal-${dir}-`));
}

test("Store.save coalesces a burst into one durable write", async (t) => {
  const dir = await tmp("debounce");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir, { debounceMs: 25 });
  await store.load();
  await store.save({
    version: 2, sessions: [], envProfiles: [], hooks: [], launches: [],
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "S1", command: "" }],
  });
  await store.save({
    version: 2, sessions: [], envProfiles: [], hooks: [], launches: [],
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "S2", command: "" }],
  });
  await store.flush();
  const onDisk = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(onDisk.presets[0].name, "S2", "latest args win");
});

test("Store.save rejects when the underlying write fails", async (t) => {
  const dir = await tmp("debounce-fail");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir, { debounceMs: 5 });
  await store.load();
  // Make `state.json` a directory so the rename inside atomicJson fails.
  await writeFile(path.join(dir, "state.json"), ""); // touch
  await rm(path.join(dir, "state.json"), { force: true });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(dir, "state.json"));
  await assert.rejects(store.save({
    version: 2, sessions: [], envProfiles: [], hooks: [], launches: [],
    presets: [],
  }));
  await store.close();
});

test("Store.close drains pending writes before resolving", async (t) => {
  const dir = await tmp("debounce-close");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new Store(dir, { debounceMs: 100 });
  await store.load();
  await store.save({
    version: 2, sessions: [], envProfiles: [], hooks: [], launches: [],
    presets: [{ id: "00000000-0000-4000-8000-000000000001", name: "Settled", command: "" }],
  });
  await store.close();
  const onDisk = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  assert.equal(onDisk.presets[0].name, "Settled");
});

test("EventBus.publishMany coalesces journal writes within the debounce window", async (t) => {
  const dir = await tmp("bus-debounce");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bus = new EventBus(dir, 100);
  await bus.initialize();
  // A burst of 10 publishes all resolve immediately (subscribers fire synchronously
  // inside the mutex) but only one journal write occurs.
  const seqs = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    bus.publish({ type: "engine-restored", sourceId: `s${i}`, data: {} })));
  assert.deepEqual(seqs.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await bus.flush();
  const reopened = new EventBus(dir, 100);
  await reopened.initialize();
  assert.equal(reopened.replay(0).latestSeq, 10);
  await reopened.close();
});

test("EventBus subscribers see events in seq order even when journal is debounced", async (t) => {
  const dir = await tmp("bus-order");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bus = new EventBus(dir, 100);
  await bus.initialize();
  const seen: number[] = [];
  bus.subscribe((event) => seen.push(event.seq));
  for (let i = 0; i < 50; i++) {
    await bus.publish({ type: "engine-restored", sourceId: "s", data: {} });
  }
  assert.deepEqual(seen, Array.from({ length: 50 }, (_, i) => i + 1));
  await bus.close();
});

test("atomicJson honours the durability option for crash vs strong", async (t) => {
  const dir = await tmp("atomic-durability");
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const durability of ["strong", "async-strong", "crash"] as Durability[]) {
    const file = path.join(dir, `${durability}.json`);
    await atomicJson(file, { ok: durability }, { durability });
    const contents = await readFile(file, "utf8");
    assert.equal(JSON.parse(contents).ok, durability);
  }
});

test("Store.load() recovers from a malformed state.json without overwriting it", async (t) => {
  // A corrupted state.json must not be a fatal startup error. The file
  // stays byte-for-byte identical on disk; the in-memory state is the
  // empty default; and `recoveredFromInvalid` exposes the reason so the
  // renderer can show a non-blocking toast.
  const dir = await tmp("store-recover");
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const malformed = "{ this is not json, but the user wrote it on purpose }";
  await writeFile(file, malformed);
  const store = new Store(dir);
  const state = await store.load();
  // In-memory state is the empty default.
  assert.equal(state.version, 2);
  assert.deepEqual(state.sessions, []);
  assert.equal(state.presets.length, 1);
  assert.equal(state.presets[0].name, "Shell");
  // The original file is preserved byte-for-byte — no overwrite happens.
  assert.equal(await readFile(file, "utf8"), malformed);
  // Recovery is observable to callers so they can surface a toast.
  assert.match(
    store.recoveredFromInvalid ?? "",
    /Saved state could not be read; original file preserved\./,
  );
  await store.close();
});

test("Store.load() sets recoveredFromInvalid only on the malformed-state path", async (t) => {
  // A clean load (no file or a valid file) must NOT populate
  // recoveredFromInvalid — recovery is a specific, observable event.
  for (const setup of ["missing", "valid"] as const) {
    const dir = await tmp(`store-clean-${setup}`);
    t.after(() => rm(dir, { recursive: true, force: true }));
    if (setup === "valid") {
      await writeFile(
        path.join(dir, "state.json"),
        JSON.stringify({
          version: 2,
          sessions: [],
          envProfiles: [],
          hooks: [],
          launches: [],
          presets: [],
        }),
      );
    }
    const store = new Store(dir);
    await store.load();
    assert.equal(store.recoveredFromInvalid, undefined);
    await store.close();
  }
});

test("Debouncer: schedule coalesces, flush runs immediately, close drains", async () => {
  const work: number[] = [];
  // Very long window: window elapsing inside the test is not the trigger.
  const debouncer = new Debouncer<number>(
    async (n) => { work.push(n); },
    60_000,
  );
  const p1 = debouncer.schedule(1);
  const p2 = debouncer.schedule(2);
  const p3 = debouncer.schedule(3);
  assert.deepEqual(work, [], "no work runs until flush()");
  await debouncer.flush();
  assert.deepEqual(work, [3], "only the latest scheduled args ran");
  // All three callers received the same underlying promise.
  await Promise.all([p1, p2, p3]);
  await debouncer.close();
  assert.throws(() => debouncer.schedule(4));
});

test("Debouncer: flush() returns immediately when nothing is pending", async () => {
  const debouncer = new Debouncer<void>(async () => {}, 1000);
  await debouncer.flush(); // no-op
  await debouncer.close();
});

test("Debouncer: failure inside the writer rejects every coalesced caller", async () => {
  let attempts = 0;
  const debouncer = new Debouncer<void>(async () => {
    attempts++;
    throw new Error("boom");
  }, 1000);
  const a = debouncer.schedule(undefined);
  const b = debouncer.schedule(undefined);
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(attempts, 1, "only one underlying invocation despite two schedules");
});
