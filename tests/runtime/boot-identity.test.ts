/**
 * M7.3 — boot identity tests.
 *
 * Coverage:
 *   1. `mintBootIdentity` returns an identity whose `bootId` is a
 *      UUID, `pid` matches `process.pid`, and `nodeVersion` matches
 *      `process.version`.
 *   2. Repeat `mintBootIdentity` calls return the memoised identity
 *      (same `bootId`).
 *   3. `readActiveBootIdentity` reads back the row written by
 *      `mintBootIdentity` and reports the same `pid` + `bootId`.
 *   4. `purgeStaleBootIdentities` removes rows whose `pid` differs
 *      from `process.pid` and preserves the row matching
 *      `process.pid`.
 *   5. After `purgeStaleBootIdentities`, `readActiveBootIdentity`
 *      still finds the surviving row.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  mintBootIdentity,
  readActiveBootIdentity,
  purgeStaleBootIdentities,
  __resetBootIdentityForTest,
} from "../../src/runtime/db/boot-identity";

function freshDatabase(): MemoryDatabase {
  const db = new MemoryDatabase();
  for (const table of tableSpecs) {
    db.prepare(table.ddl).run();
    for (const index of table.indices) db.prepare(index).run();
  }
  return db;
}

test("M7.3 mintBootIdentity returns a UUID + correct pid + nodeVersion", () => {
  __resetBootIdentityForTest();
  const db = freshDatabase();
  try {
    const id = mintBootIdentity(db);
    assert.equal(typeof id.bootId, "string");
    assert.equal(id.bootId.length, 36, `expected UUID-shaped bootId, got ${id.bootId}`);
    assert.equal(id.pid, process.pid);
    assert.equal(id.nodeVersion, process.version);
    assert.equal(typeof id.bootedAtIso, "string");
    assert.equal(typeof id.monotonicBasisMs, "string");
    assert.ok(/^\d+$/.test(id.monotonicBasisMs), `expected integer ms string, got ${id.monotonicBasisMs}`);
  } finally { db.close(); }
});

test("M7.3 mintBootIdentity is memoised within a process", () => {
  __resetBootIdentityForTest();
  const db = freshDatabase();
  try {
    const first = mintBootIdentity(db);
    const second = mintBootIdentity(db);
    assert.equal(second.bootId, first.bootId, "expected repeated mintBootIdentity to return the memoised identity");
    assert.equal(second.bootedAtIso, first.bootedAtIso);
  } finally { db.close(); }
});

test("M7.3 readActiveBootIdentity finds the row matching process.pid", () => {
  __resetBootIdentityForTest();
  const db = freshDatabase();
  try {
    const id = mintBootIdentity(db);
    const found = readActiveBootIdentity(db);
    assert.ok(found, "expected readActiveBootIdentity to find the persisted row");
    assert.equal(found.bootId, id.bootId);
    assert.equal(found.pid, process.pid);
  } finally { db.close(); }
});

test("M7.3 purgeStaleBootIdentities removes rows for foreign pids", () => {
  __resetBootIdentityForTest();
  const db = freshDatabase();
  try {
    // Mint one identity for the current process — must survive the purge.
    const mine = mintBootIdentity(db);
    // Forge a stale row for a foreign pid by writing directly to meta.
    const foreignBootId = randomUUID();
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`dispatcher-boot:${foreignBootId}`, JSON.stringify({
        bootedAtIso: new Date().toISOString(),
        monotonicBasisMs: "0",
        pid: process.pid + 9999,
        nodeVersion: process.version,
      }));

    const removed = purgeStaleBootIdentities(db);
    assert.equal(removed, 1, `expected 1 stale row removed, got ${removed}`);

    // The stale row is gone; the active row remains.
    const active = readActiveBootIdentity(db);
    assert.ok(active);
    assert.equal(active.bootId, mine.bootId);
    assert.equal(active.pid, process.pid);
    // The foreign key is gone (scan returns only the active row).
    const all = db
      .prepare("SELECT key FROM meta WHERE key >= ? AND key < ?")
      .all("dispatcher-boot:", "dispatcher-boot;") as Array<{ key: string }>;
    const foreignRow = all.find((row) => row.key === `dispatcher-boot:${foreignBootId}`);
    assert.equal(foreignRow, undefined, "expected foreign boot row to be deleted");
  } finally { db.close(); }
});

test("M7.3 readActiveBootIdentity returns undefined when no row matches pid", () => {
  __resetBootIdentityForTest();
  const db = freshDatabase();
  try {
    // Forge a single stale row; nothing for the current pid.
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`dispatcher-boot:${randomUUID()}`, JSON.stringify({
        bootedAtIso: new Date().toISOString(),
        monotonicBasisMs: "0",
        pid: process.pid + 9999,
        nodeVersion: process.version,
      }));
    const found = readActiveBootIdentity(db);
    assert.equal(found, undefined);
  } finally { db.close(); }
});
