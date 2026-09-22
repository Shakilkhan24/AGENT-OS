/**
 * Focused tests for M2.5 — snapshot + database-generation handshake.
 *
 * Tests prove:
 *  - the generation counter advances atomically with mutations;
 *  - a snapshot's counts match the live table sizes;
 *  - replaySince returns events strictly greater than the cursor, with
 *    deduplication by seq;
 *  - lossless cursor encoding round-trips, refuses out-of-range values,
 *    and never collides between (g, s) pairs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  bumpGeneration, currentGeneration, losslessDecode, losslessEncode, replaySince, takeSnapshot,
} from "../../src/runtime/db/snapshot";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) driver.prepare(table.ddl).run();
  return new DbWorker({ driver });
}

test("takeSnapshot increments the generation and reflects live counts", async () => {
  const worker = freshWorker();
  try {
    const before = await currentGeneration(worker);
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
    driver.prepare("INSERT INTO preset (uuid, name, command) VALUES (?, ?, ?)")
      .run("00000000-0000-4000-8000-000000000001", "Shell", "");
    driver.prepare("INSERT INTO session (uuid, name, directory, identity, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run("11111111-1111-4111-8111-111111111111", "alpha", "/tmp/alpha", "ident", new Date().toISOString(), "{}");
    const snap = await takeSnapshot(worker);
    assert.equal(snap.generation, before + 1);
    assert.equal(snap.counts.sessions, 1);
    assert.equal(snap.counts.presets, 1);
  } finally { await worker.close(); }
});

test("bumpGeneration is monotonic and concurrent-safe inside the worker queue", async () => {
  const worker = freshWorker();
  try {
    const before = await currentGeneration(worker);
    const results = await Promise.all([bumpGeneration(worker), bumpGeneration(worker), bumpGeneration(worker)]);
    assert.deepEqual(results, [before + 1, before + 2, before + 3]);
  } finally { await worker.close(); }
});

test("replaySince returns events strictly greater than the cursor, deduped by seq", async () => {
  const worker = freshWorker();
  try {
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
    const insertEvent = driver.prepare("INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertEvent.run(1, "2026-09-13T10:00:00.000Z", "11111111-1111-4111-8111-111111111111", "sessions", null, null, null, "session-changed", JSON.stringify({ action: "created" }));
    insertEvent.run(2, "2026-09-13T10:00:01.000Z", "22222222-2222-4222-8222-222222222222", "sessions", null, null, null, "session-changed", JSON.stringify({ action: "updated" }));
    insertEvent.run(3, "2026-09-13T10:00:02.000Z", "33333333-3333-4333-8333-333333333333", "sessions", null, null, null, "session-changed", JSON.stringify({ action: "deleted" }));
    // Insert a duplicate seq: replay must deduplicate.
    insertEvent.run(3, "2026-09-13T10:00:02.000Z", "44444444-4444-4444-8444-444444444444", "sessions", null, null, null, "session-changed", JSON.stringify({ action: "deleted" }));
    const replay = await replaySince(worker, 1);
    assert.equal(replay.events.length, 2, "replay must dedupe by seq and skip < fromSeq");
    assert.equal(replay.events[0]?.seq, 2);
    assert.equal(replay.events[1]?.seq, 3);
    assert.equal(replay.latestSeq, 3);
    assert.equal(replay.oldestSeq, 1);
  } finally { await worker.close(); }
});

test("losslessEncode round-trips and refuses out-of-range values", () => {
  const cursor = losslessEncode(123, 456);
  const decoded = losslessDecode(cursor);
  assert.deepEqual(decoded, { generation: 123, seq: 456 });
  assert.equal(losslessDecode("not-a-cursor"), null);
  assert.throws(() => losslessEncode(-1, 0), /non-negative/);
  assert.throws(() => losslessEncode(0, -1), /non-negative/);
  assert.throws(() => losslessEncode(0x80000000, 0), /range/);
});

test("lossless cursors never collide between distinct (g, s) pairs", () => {
  const a = losslessEncode(1, 2);
  const b = losslessEncode(2, 1);
  assert.notEqual(a, b);
  assert.equal(losslessEncode(0, 0), "0000000-0000000");
});

test("replaySince marks truncation when the cursor predates the oldest event", async () => {
  const worker = freshWorker();
  try {
    const driver = (worker as unknown as { driver: { prepare: (sql: string) => { run: (...b: unknown[]) => void } } }).driver;
    driver.prepare("INSERT INTO event (seq, at, correlation_id, source_id, session_uuid, terminal_uuid, origin_hook_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(10, "2026-09-13T10:00:00.000Z", "11111111-1111-4111-8111-111111111111", "sessions", null, null, null, "session-changed", JSON.stringify({ action: "created" }));
    const replay = await replaySince(worker, 0);
    assert.equal(replay.truncated, true);
  } finally { await worker.close(); }
});
