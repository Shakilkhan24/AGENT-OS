/**
 * M3b.3 — SpoolGuard tests.
 *
 * Coverage:
 *  - `reserve` allocates sequential seqs and tracks bytes correctly.
 *  - Past the quota, `reserve` returns `quota-exhausted` without
 *    allocating a seq.
 *  - `commit` stores bytes durably; replay returns them in order.
 *  - `abort` releases a reserved seq without keeping the bytes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SpoolGuard } from "../../../src/runtime/orchestration/spool";

test("reserve allocates sequential seqs and tracks bytes", () => {
  const spool = new SpoolGuard();
  const a = spool.reserve(8);
  assert.equal(a.ok, true);
  if (a.ok) assert.equal(a.seq, 1);
  const b = spool.reserve(16);
  assert.equal(b.ok, true);
  if (b.ok) assert.equal(b.seq, 2);
  assert.equal(spool.queued, 24);
});

test("past the quota, reserve returns quota-exhausted", () => {
  const spool = new SpoolGuard({ quotaBytes: 100 });
  const first = spool.reserve(60);
  assert.equal(first.ok, true);
  const second = spool.reserve(60);
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.reason, "quota-exhausted");
});

test("commit then replay returns bytes in seq order", () => {
  const spool = new SpoolGuard();
  const a = spool.reserve(2);
  const b = spool.reserve(3);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (a.ok) spool.commit(a.seq, new Uint8Array([1, 2]));
  if (b.ok) spool.commit(b.seq, new Uint8Array([3, 4, 5]));
  const replay = [...spool.replay()];
  assert.equal(replay.length, 2);
  assert.deepEqual(Array.from(replay[0]!.bytes), [1, 2]);
  assert.deepEqual(Array.from(replay[1]!.bytes), [3, 4, 5]);
  assert.equal(spool.committedBytes(), 5);
});

test("abort frees the reserved quota", () => {
  const spool = new SpoolGuard({ quotaBytes: 100 });
  const a = spool.reserve(60);
  assert.equal(a.ok, true);
  spool.abort(a.ok ? a.seq : 0);
  // Quota is freed; the next reserve can use it.
  const second = spool.reserve(80);
  assert.equal(second.ok, true);
});

test("commit rejects duplicate seq", () => {
  const spool = new SpoolGuard();
  const a = spool.reserve(4);
  assert.equal(a.ok, true);
  if (a.ok) {
    spool.commit(a.seq, new Uint8Array([1, 2, 3, 4]));
    assert.throws(() => spool.commit(a.seq, new Uint8Array([5, 6])), /already committed/);
  }
});
