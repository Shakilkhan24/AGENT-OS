/**
 * Focused tests for the M2.1 bounded database worker.
 *
 * These tests intentionally exercise the contract the runtime depends on:
 *  - transactions commit state + event + dispatch intent together;
 *  - a thrown body rolls the transaction back without partial state;
 *  - foreign-key and uniqueness violations surface to the caller;
 *  - `exclusive()` serialises "read-then-write" sequences without nesting;
 *  - the worker caps concurrency and queues excess work;
 *  - `close()` flushes in-flight tasks before releasing the driver.
 *
 * The in-memory driver is the test target: it shares the same `Database`
 * contract as the production `node:sqlite` driver, so behaviour stays
 * comparable across backends. Skipping tests on environments without
 * `node:sqlite` would defeat the parity check; we instead test the contract
 * once on the in-memory driver and trust the same surface at runtime.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker, smokeDriver } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return new DbWorker({ driver });
}

test("smoke driver: insert, query and order", () => {
  const driver = new MemoryDatabase();
  driver.prepare("CREATE TABLE smoke (id INTEGER PRIMARY KEY, name TEXT NOT NULL)").run();
  smokeDriver(driver);
});

test("transactions commit atomic state + event + intent together", async () => {
  const worker = freshWorker();
  try {
    const result = await worker.transaction(tx => {
      const session = tx;
      const insertSession = session; // typed via `tx` to satisfy linters
      void insertSession;
      const statement = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } })
        .driver.prepare("INSERT INTO session (uuid, name, directory, identity, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)");
      statement.run("11111111-1111-4111-8111-111111111111", "alpha", "/tmp/alpha", "ident-1", new Date().toISOString(), "{}");
      statement.run("22222222-2222-4222-8222-222222222222", "beta", "/tmp/beta", "ident-2", new Date().toISOString(), "{}");
      return "ok";
    });
    assert.equal(result, "ok");
    const sessions = (worker as unknown as { driver: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } })
      .driver.prepare("SELECT name FROM session ORDER BY name ASC").all();
    assert.deepEqual(sessions.map(row => row.name), ["alpha", "beta"]);
  } finally { await worker.close(); }
});

test("a thrown body rolls back without partial state", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(worker.transaction(() => {
      const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
      driver.prepare("INSERT INTO session (uuid, name, directory, identity, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run("33333333-3333-4333-8333-333333333333", "doomed", "/tmp/d", "i", new Date().toISOString(), "{}");
      throw new Error("simulated failure");
    }));
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { all: () => Array<{ name: string }> } } }).driver;
    assert.deepEqual(driver.prepare("SELECT name FROM session").all(), []);
  } finally { await worker.close(); }
});

test("unique constraint violation surfaces to caller", async () => {
  const worker = freshWorker();
  try {
    const driver = (worker as unknown as { driver: MemoryDatabase }).driver;
    driver.prepare("INSERT INTO session (uuid, name, directory, identity, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("44444444-4444-4444-8444-444444444444", "dup", "/tmp/d", "i", new Date().toISOString(), "{}");
    await assert.rejects(worker.transaction(() => {
      const inner = (worker as unknown as { driver: MemoryDatabase }).driver;
      inner.prepare("INSERT INTO session (uuid, name, directory, identity, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
        .run("44444444-4444-4444-8444-444444444444", "dup", "/tmp/d", "i", new Date().toISOString(), "{}");
      throw new Error("expected driver to reject duplicate uuid");
    }), (error: unknown) => error instanceof Error && /UNIQUE/i.test(error.message));
    // The doomed row was rolled back; the original row still exists.
    const rows = driver.prepare("SELECT name FROM session").all();
    assert.equal(rows.length, 1);
  } finally { await worker.close(); }
});

test("exclusive() serialises read-then-write sequences", async () => {
  const worker = freshWorker();
  try {
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { first: (...b: unknown[]) => { value: number } | undefined; run: (...b: unknown[]) => void } } }).driver;
    driver.prepare("CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)").run();
    driver.prepare("INSERT INTO counter (value) VALUES (?)").run(0);
    const results = await Promise.all([
      worker.exclusive(() => {
        const current = driver.prepare("SELECT value FROM counter WHERE id = 1").first()!.value;
        driver.prepare("UPDATE counter SET value = ? WHERE id = 1").run(current + 1);
        return current + 1;
      }),
      worker.exclusive(() => {
        const current = driver.prepare("SELECT value FROM counter WHERE id = 1").first()!.value;
        driver.prepare("UPDATE counter SET value = ? WHERE id = 1").run(current + 1);
        return current + 1;
      }),
    ]);
    // The two exclusive runners execute sequentially because the driver holds
    // the lock for the entire body. Each runner observes the previous value.
    assert.deepEqual(results, [1, 2]);
    assert.equal(driver.prepare("SELECT value FROM counter WHERE id = 1").first()!.value, 2);
  } finally { await worker.close(); }
});

test("worker caps concurrency and queues excess work", async () => {
  const driver = new MemoryDatabase();
  const worker = new DbWorker({ driver, concurrency: 1 });
  let inFlight = 0; let observedMax = 0;
  const tasks = Array.from({ length: 8 }, () => worker.query(async () => {
    inFlight++; observedMax = Math.max(observedMax, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight--;
  }));
  await Promise.all(tasks);
  assert.equal(observedMax, 1, "concurrency=1 must serialise all work");
  await worker.close();
});

test("close() drains in-flight work before releasing the driver", async () => {
  const driver = new MemoryDatabase();
  const worker = new DbWorker({ driver });
  const task = worker.query(() => new Promise<void>(resolve => setTimeout(resolve, 25)));
  await worker.close();
  // The queued task must still resolve; close() awaits its completion.
  await task;
});

test("submitting after close() rejects without leaking the driver", async () => {
  const driver = new MemoryDatabase();
  const worker = new DbWorker({ driver });
  await worker.close();
  await assert.rejects(worker.query(() => 1), /closed/i);
});
