/**
 * M5.5 — attachment registry tests.
 *
 * Coverage (14 focused tests):
 *  - registerAttachment: ok kind=owner; conflict owner-already-set
 *    on second owner without surrenderToken; ok kind=observer
 *    when an owner already exists.
 *  - unregisterAttachment: conflict on stale expectedGeneration;
 *    cancels pending owner-input.
 *  - publishOutput: delivers to every subscriber + decrements credits;
 *    pauses a slow observer with pausedReason "high-watermark";
 *    does NOT block other subscriptions when one observer is paused.
 *  - requestResize: forbidden resize-owner-only for non-owners; ok
 *    + generation bump for the owner with the expected generation.
 *  - sendInput: admits bytes to the owner's TerminalInputQueue.
 *  - transferOwnership: forbidden surrender-token-mismatch when
 *    token wrong; success + generation bump + prior-owner cancellation.
 *  - enforceOwnershipHandover: abandons every observer and writes
 *    the abandoned meta row when the owner has been detached past
 *    OWNERSHIP_HANDOVER_TIMEOUT_MS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { TerminalInputQueue } from "../../src/runtime/input-queue";
import {
  createAttachmentRegistry,
  DEFAULT_OBSERVER_BYTE_CREDITS,
  DEFAULT_OWNER_BYTE_CREDITS,
  OWNERSHIP_HANDOVER_TIMEOUT_MS,
  ABANDONED_ROW_META_PREFIX,
  OWNERSHIP_ROW_META_PREFIX,
  SUBSCRIPTION_ROW_META_PREFIX,
} from "../../src/runtime/orchestration/attachment-registry";
import { randomUUID } from "node:crypto";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const terminalUuid = (): string => randomUUID();
const subscriberUuid = (): string => randomUUID();

test("registerAttachment returns ok with kind=owner when no owner exists", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const result = await registry.registerAttachment({
      terminalUuid: terminalUuid(),
      subscriberId: subscriberUuid(),
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.value.kind, "owner");
      assert.equal(result.value.generation, 1);
      assert.equal(result.value.remainingByteCredits, DEFAULT_OWNER_BYTE_CREDITS);
    }
  } finally { await worker.close(); }
});

test("registerAttachment returns conflict owner-already-set when a second owner attaches without a valid surrenderToken", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const first = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subscriberUuid(),
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(first.kind, "ok");
    const second = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subscriberUuid(),
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(second.kind, "conflict");
    if (second.kind === "conflict") {
      assert.match(second.reason, /owner-already-set/);
    }
  } finally { await worker.close(); }
});

test("registerAttachment returns ok with kind=observer when an owner already exists", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerResult = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subscriberUuid(),
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(ownerResult.kind, "ok");
    const observerResult = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subscriberUuid(),
      kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(observerResult.kind, "ok");
    if (observerResult.kind === "ok") {
      assert.equal(observerResult.value.kind, "observer");
      assert.equal(observerResult.value.remainingByteCredits, DEFAULT_OBSERVER_BYTE_CREDITS);
    }
  } finally { await worker.close(); }
});

test("unregisterAttachment returns conflict when expectedGeneration is stale (rejects a stale detachment)", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const subId = subscriberUuid();
    const reg = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subId,
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(reg.kind, "ok");
    // Re-register the same subscriber with a fresh generation.
    const reg2 = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subId,
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 1,
    });
    assert.equal(reg2.kind, "ok");
    // Now an old detach with the stale generation must be refused.
    const detach = await registry.unregisterAttachment({
      terminalUuid: t,
      subscriberId: subId,
      expectedGeneration: 0,
    });
    assert.equal(detach.kind, "conflict");
    if (detach.kind === "conflict") {
      assert.match(detach.reason, /expected-generation-mismatch/);
    }
  } finally { await worker.close(); }
});

test("unregisterAttachment cancels the owner's pending input when the owner detaches", async () => {
  const worker = freshWorker();
  try {
    const bridgeMock = { calls: [] as Array<{ token: string; data: string }> };
    const queue = new TerminalInputQueue(async (token, data) => {
      bridgeMock.calls.push({ token, data });
      // Don't resolve — leave admitted bytes pending so cancel has work.
      await new Promise(() => {});
    });
    const registry = createAttachmentRegistry(worker, { inputQueue: queue });
    const t = terminalUuid();
    const subId = subscriberUuid();
    const reg = await registry.registerAttachment({
      terminalUuid: t,
      subscriberId: subId,
      kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS,
      expectedGeneration: 0,
    });
    assert.equal(reg.kind, "ok");
    if (reg.kind === "ok") {
      const send = await registry.sendInput({
        terminalUuid: t,
        subscriberId: subId,
        data: "hello world",
        expectedGeneration: reg.value.generation,
      });
      assert.equal(send.kind, "ok");
    }
    const detach = await registry.unregisterAttachment({
      terminalUuid: t,
      subscriberId: subId,
      expectedGeneration: 1,
    });
    assert.equal(detach.kind, "ok");
    if (detach.kind === "ok") {
      assert.equal(detach.value.dropped, 1);
    }
    const progress = queue.progress(subId);
    assert.equal(progress.queued, 0);
  } finally { await worker.close(); }
});

test("publishOutput delivers to every active subscription and decrements each subscriber's remainingByteCredits", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const observerId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: observerId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    const data = "x".repeat(100);
    const result = await registry.publishOutput({ terminalUuid: t, data, cursor: 0 });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const perSub = result.value.perSubscriber;
      const ownerEntry = perSub.find(p => p.subscriberId === ownerId);
      const observerEntry = perSub.find(p => p.subscriberId === observerId);
      assert.ok(ownerEntry, "owner must receive a publish entry");
      assert.ok(observerEntry, "observer must receive a publish entry");
      assert.equal(ownerEntry.deliveredBytes, 100);
      assert.equal(observerEntry.deliveredBytes, 100);
      assert.equal(ownerEntry.remainingByteCredits, DEFAULT_OWNER_BYTE_CREDITS - 100);
      assert.equal(observerEntry.remainingByteCredits, DEFAULT_OBSERVER_BYTE_CREDITS - 100);
    }
  } finally { await worker.close(); }
});

test("publishOutput marks a slow observer paused with pausedReason high-watermark when that subscriber's outstanding bytes exceed the high watermark", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const slowId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: slowId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    // Publish enough bytes to cross the 256 KiB high-watermark.
    const data = "y".repeat(64 * 1024);
    let lastPauseReason: string | null = null;
    let observedSlow = false;
    for (let i = 0; i < 8; i++) {
      const r = await registry.publishOutput({ terminalUuid: t, data, cursor: i * data.length });
      assert.equal(r.kind, "ok");
      if (r.kind === "ok") {
        const slowEntry = r.value.perSubscriber.find(p => p.subscriberId === slowId);
        if (slowEntry && slowEntry.pausedReason === "high-watermark") {
          observedSlow = true;
          lastPauseReason = slowEntry.pausedReason;
        }
      }
    }
    assert.ok(observedSlow, `expected the slow observer to trip high-watermark; last=${lastPauseReason}`);
  } finally { await worker.close(); }
});

test("publishOutput does NOT block the other subscriptions when one observer is paused", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const slowId = subscriberUuid();
    const healthyId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: slowId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: healthyId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    const data = "z".repeat(64 * 1024);
    for (let i = 0; i < 8; i++) {
      await registry.publishOutput({ terminalUuid: t, data, cursor: i * data.length });
    }
    // Healthy observer keeps draining across the pause.
    const result = await registry.publishOutput({ terminalUuid: t, data: "final", cursor: 8 * data.length });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const slowEntry = result.value.perSubscriber.find(p => p.subscriberId === slowId);
      const healthyEntry = result.value.perSubscriber.find(p => p.subscriberId === healthyId);
      assert.ok(slowEntry);
      assert.ok(healthyEntry);
      // Healthy subscriber continues to drain while the slow one is paused.
      assert.equal(healthyEntry.deliveredBytes, 5);
      // The slow one continues to receive bytes (delivery doesn't stop; only
      // the publisher marks it paused); the entry is present.
      assert.equal(slowEntry.deliveredBytes, 5);
      assert.equal(slowEntry.pausedReason, "high-watermark");
    }
  } finally { await worker.close(); }
});

test("requestResize returns forbidden resize-owner-only when the subscriber is not the owner", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const observerId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: observerId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    const result = await registry.requestResize({
      terminalUuid: t, subscriberId: observerId, cols: 80, rows: 24, expectedGeneration: 1,
    });
    assert.equal(result.kind, "forbidden");
    if (result.kind === "forbidden") {
      assert.match(result.reason, /resize-owner-only/);
    }
  } finally { await worker.close(); }
});

test("requestResize returns ok and bumps the owner's generation when the owner calls with the expected generation", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const reg = await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    assert.equal(reg.kind, "ok");
    let liveGen = 1;
    if (reg.kind === "ok") liveGen = reg.value.generation;
    const result = await registry.requestResize({
      terminalUuid: t, subscriberId: ownerId, cols: 80, rows: 24, expectedGeneration: liveGen,
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.value.newGeneration, liveGen + 1);
    }
  } finally { await worker.close(); }
});

test("sendInput admits bytes to the owner's TerminalInputQueue when the owner is the caller", async () => {
  const worker = freshWorker();
  try {
    const queue = new TerminalInputQueue(async (_token, _data) => undefined);
    const registry = createAttachmentRegistry(worker, { inputQueue: queue });
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const reg = await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    assert.equal(reg.kind, "ok");
    let liveGen = 1;
    if (reg.kind === "ok") liveGen = reg.value.generation;
    const result = await registry.sendInput({
      terminalUuid: t, subscriberId: ownerId, data: "hello", expectedGeneration: liveGen,
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.value.admittedBytes, 5);
    }
  } finally { await worker.close(); }
});

test("transferOwnership refuses forbidden surrender-token-mismatch when the supplied token does not match the current owner's surrenderToken", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const successorId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: successorId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    const wrongToken = "0".repeat(64);
    const result = await registry.transferOwnership({
      terminalUuid: t,
      fromSubscriberId: ownerId,
      toSubscriberId: successorId,
      surrenderToken: wrongToken,
      toExpectedGeneration: 1,
    });
    assert.equal(result.kind, "forbidden");
    if (result.kind === "forbidden") {
      assert.match(result.reason, /surrender-token-mismatch/);
    }
  } finally { await worker.close(); }
});

test("transferOwnership succeeds and increments the new owner's generation (and cancels the prior owner's pending input)", async () => {
  const worker = freshWorker();
  try {
    const queue = new TerminalInputQueue(async (_token, _data) => {
      await new Promise(() => {}); // never resolves — keeps bytes pending
    });
    const registry = createAttachmentRegistry(worker, { inputQueue: queue });
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const successorId = subscriberUuid();
    const ownerReg = await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    assert.equal(ownerReg.kind, "ok");
    let ownerGen = 1;
    if (ownerReg.kind === "ok") ownerGen = ownerReg.value.generation;
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: successorId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    // Queue some input for the current owner so cancellation has work.
    const sendResult = await registry.sendInput({
      terminalUuid: t, subscriberId: ownerId, data: "queued", expectedGeneration: ownerGen,
    });
    assert.equal(sendResult.kind, "ok");
    // Read the live surrenderToken from the ownership meta row.
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    const row = driver.prepare("SELECT value FROM meta WHERE key = ?")
      .first(`${OWNERSHIP_ROW_META_PREFIX}${t}`);
    assert.ok(row, "ownership meta row must be persisted");
    const parsed = JSON.parse(String((row as Record<string, unknown>).value)) as { surrenderToken: string };
    const result = await registry.transferOwnership({
      terminalUuid: t,
      fromSubscriberId: ownerId,
      toSubscriberId: successorId,
      surrenderToken: parsed.surrenderToken,
      toExpectedGeneration: 1,
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.value.kind, "owner");
      assert.equal(result.value.generation, 2);
    }
    // Prior owner's pending input was cancelled.
    const progress = queue.progress(ownerId);
    assert.equal(progress.queued, 0);
  } finally { await worker.close(); }
});

test("enforceOwnershipHandover abandons every observer and writes the abandoned meta row when the owner has been detached past OWNERSHIP_HANDOVER_TIMEOUT_MS", async () => {
  const worker = freshWorker();
  try {
    const registry = createAttachmentRegistry(worker);
    const t = terminalUuid();
    const ownerId = subscriberUuid();
    const observerId = subscriberUuid();
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: ownerId, kind: "owner",
      attaches: ["interactive", "resize", "output"],
      initialByteCredits: DEFAULT_OWNER_BYTE_CREDITS, expectedGeneration: 0,
    });
    await registry.registerAttachment({
      terminalUuid: t, subscriberId: observerId, kind: "observer",
      attaches: ["output"],
      initialByteCredits: DEFAULT_OBSERVER_BYTE_CREDITS, expectedGeneration: 0,
    });
    // Owner detaches.
    await registry.unregisterAttachment({
      terminalUuid: t, subscriberId: ownerId, expectedGeneration: 1,
    });
    // Force a backdate on the in-memory `ownerDetachedAt` so the
    // handover is treated as overdue without us having to wait
    // the full `OWNERSHIP_HANDOVER_TIMEOUT_MS`.
    const snap = registry.__debugSnapshot();
    snap.get(t)!.ownerDetachedAt = Date.now() - (OWNERSHIP_HANDOVER_TIMEOUT_MS + 100);
    const result = await registry.enforceOwnershipHandover(t);
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.deepEqual(result.value, { abandoned: true });
    }
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    const abandoned = driver.prepare("SELECT value FROM meta WHERE key = ?")
      .first(`${ABANDONED_ROW_META_PREFIX}${t}`);
    assert.ok(abandoned, "abandoned meta row must be persisted");
    const subscriptionCleared = driver.prepare("SELECT value FROM meta WHERE key = ?")
      .first(`${SUBSCRIPTION_ROW_META_PREFIX}${t}:${observerId}`);
    assert.equal(subscriptionCleared, undefined);
  } finally { await worker.close(); }
});
