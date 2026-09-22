/**
 * M3c.3 — `listOpenAttention` + `snoozeAttention` tests.
 *
 * Coverage:
 *  1. `listOpenAttention` excludes `dismissed` and `resolved`,
 *     includes `new/seen/snoozed` whose `snoozed_until` is null or
 *     past.
 *  2. `listOpenAttention(now)` excludes a row whose `snoozed_until`
 *     is strictly in the future.
 *  3. `snoozeAttention` on a `new` row transitions to `snoozed` AND
 *     sets `snoozed_until`. (FSM widening: `new → seen → snoozed`.)
 *  4. `snoozeAttention` rejects `until <= now` with `INVALID_REQUEST`.
 *  5. `snoozeAttention` on a `seen` row keeps state `snoozed` and
 *     writes the new deadline.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  listOpenAttention,
  raiseAttention,
  snoozeAttention,
  transitionAttention,
} from "../../src/runtime/db/attention-items";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

test("listOpenAttention excludes resolved/dismissed and includes open items", async () => {
  const worker = freshWorker();
  try {
    const open = await raiseAttention(worker, { kind: "decision", issueIdentity: "open-1", revision: 0 });
    const seen = await raiseAttention(worker, { kind: "decision", issueIdentity: "seen-1", revision: 0 });
    await transitionAttention(worker, seen.id, "seen");
    const snoozed = await raiseAttention(worker, { kind: "decision", issueIdentity: "snoozed-1", revision: 0 });
    await transitionAttention(worker, snoozed.id, "seen");
    await transitionAttention(worker, snoozed.id, "snoozed");
    const dismissed = await raiseAttention(worker, { kind: "decision", issueIdentity: "dismissed-1", revision: 0 });
    await transitionAttention(worker, dismissed.id, "seen");
    await transitionAttention(worker, dismissed.id, "dismissed");
    const resolved = await raiseAttention(worker, { kind: "decision", issueIdentity: "resolved-1", revision: 0 });
    await transitionAttention(worker, resolved.id, "resolved");
    void open;
    const list = await listOpenAttention(worker);
    const identities = list.map(item => item.issueIdentity);
    assert.deepEqual(new Set(identities), new Set(["open-1", "seen-1", "snoozed-1"]));
    // Sorted updated_at DESC.
    for (let i = 1; i < list.length; i++)
      assert.ok(list[i - 1]!.updatedAt >= list[i]!.updatedAt);
  } finally { await worker.close(); }
});

test("listOpenAttention(now) excludes a snoozed row whose snoozed_until is in the future", async () => {
  const worker = freshWorker();
  try {
    const now = new Date();
    const future = new Date(now.getTime() + 60 * 60_000);
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "future-snooze", revision: 0 });
    await snoozeAttention(worker, { id: item.id, until: future });
    // Re-query with a "now" earlier than the snooze deadline.
    const earlierNow = new Date(now.getTime() + 1000);
    const filtered = await listOpenAttention(worker, earlierNow);
    assert.equal(filtered.length, 0);
    // With "now" past the deadline, the row reappears.
    const laterNow = new Date(future.getTime() + 1000);
    const afterDeadline = await listOpenAttention(worker, laterNow);
    assert.equal(afterDeadline.length, 1);
    assert.equal(afterDeadline[0]!.issueIdentity, "future-snooze");
    assert.equal(afterDeadline[0]!.state, "snoozed");
  } finally { await worker.close(); }
});

test("snoozeAttention on a new row transitions to snoozed AND sets snoozed_until (FSM widening)", async () => {
  const worker = freshWorker();
  try {
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "widen", revision: 0 });
    const until = new Date(Date.now() + 30 * 60_000);
    const after = await snoozeAttention(worker, { id: item.id, until });
    assert.equal(after.state, "snoozed");
    assert.equal(after.snoozedUntil, until.toISOString());
  } finally { await worker.close(); }
});

test("snoozeAttention rejects until <= now with INVALID_REQUEST", async () => {
  const worker = freshWorker();
  try {
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "past", revision: 0 });
    const past = new Date(Date.now() - 1000);
    await assert.rejects(
      snoozeAttention(worker, { id: item.id, until: past }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("snoozeAttention on a seen row keeps state snoozed and writes the new deadline (re-snooze)", async () => {
  const worker = freshWorker();
  try {
    const item = await raiseAttention(worker, { kind: "decision", issueIdentity: "resnooze", revision: 0 });
    await transitionAttention(worker, item.id, "seen");
    const first = new Date(Date.now() + 60_000);
    const afterFirst = await snoozeAttention(worker, { id: item.id, until: first });
    assert.equal(afterFirst.state, "snoozed");
    assert.equal(afterFirst.snoozedUntil, first.toISOString());

    const second = new Date(Date.now() + 60 * 60_000);
    const afterSecond = await snoozeAttention(worker, { id: item.id, until: second });
    assert.equal(afterSecond.state, "snoozed");
    assert.equal(afterSecond.snoozedUntil, second.toISOString());
  } finally { await worker.close(); }
});
