import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqliteDatabase, hasSqliteBuiltin } from "../../src/runtime/db/sqlite";
import { openManagedDatabase } from "../../src/runtime/db-owner";
import { createTask, readTask } from "../../src/runtime/db/tasks";

test("the supported ESM runtime detects real SQLite without a CommonJS require", () => {
  assert.equal(hasSqliteBuiltin(), true);
});

test("real SQLite commits state and rolls back a partially written transaction", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.prepare("CREATE TABLE entries (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)").run();
    const insert = db.prepare("INSERT INTO entries (name) VALUES (?)");
    assert.equal(db.transaction(() => { insert.run("kept"); return 42; }), 42);
    assert.throws(() => db.transaction(() => {
      insert.run("discarded");
      insert.run("kept");
    }), /UNIQUE/);
    assert.deepEqual(db.prepare("SELECT name FROM entries").all().map(row => row.name), ["kept"]);
    assert.throws(() => db.transaction(() => {
      insert.run("also discarded");
      throw new Error("injected failure");
    }), /injected failure/);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entries").first()?.count, 1);
  } finally { db.close(); }
});

test("real SQLite enforces foreign keys", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.prepare("CREATE TABLE parents (id INTEGER PRIMARY KEY)").run();
    db.prepare("CREATE TABLE children (parent INTEGER REFERENCES parents(id))").run();
    assert.throws(() => db.transaction(() => {
      db.prepare("INSERT INTO children (parent) VALUES (?)").run(123);
    }), /FOREIGN KEY/);
  } finally { db.close(); }
});

test("real SQLite rejects async transaction bodies before they can write", async () => {
  const db = new SqliteDatabase(":memory:");
  let called = false;
  try {
    assert.throws(() => db.transaction(async () => { called = true; }), /synchronous/i);
    assert.equal(called, false);
    db.prepare("CREATE TABLE entries (name TEXT)").run();
    assert.throws(() => db.transaction(() => {
      db.prepare("INSERT INTO entries (name) VALUES (?)").run("discarded");
      return Promise.resolve();
    }), /synchronous/i);
    assert.deepEqual(db.prepare("SELECT * FROM entries").all(), []);
  } finally { db.close(); }
});

test("the production database owner preserves managed work across close and reopen", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "minimal-real-sqlite-"));
  let owned: Awaited<ReturnType<typeof openManagedDatabase>> | undefined;
  try {
    owned = await openManagedDatabase(dir, path.join(dir, "runtime"));
    assert.equal(owned.location, "sqlite", "production must never silently fall back to volatile memory");
    const task = await createTask(owned.worker, { title: "Persisted repair", hostId: "local" });
    await owned.close();
    owned = await openManagedDatabase(dir, path.join(dir, "runtime"));
    assert.equal((await readTask(owned.worker, task.id))?.title, task.task.title);
  } finally {
    await owned?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
