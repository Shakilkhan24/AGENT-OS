/**
 * M9.4 — event-bus retention floor.
 *
 * The event journal keeps a hard cap (`limit`) on retained events,
 * but the M9.4 retention floor promises that
 * `pending-decision`, `live-intent`, and `recoverable-candidate`
 * entries are NEVER dropped by the cap. This suite exercises the
 * classification + slice behaviour the runtime relies on.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../../src/main/event-bus";

async function makeBus(limit: number) {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-evtbus-floor-"));
  const cleanup = () => rm(root, { recursive: true, force: true });
  const bus = new EventBus(root, limit);
  await bus.initialize();
  return { bus, root, cleanup };
}

test("operational entries are sliced at limit", async () => {
  const { bus, cleanup } = await makeBus(2);
  try {
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.flush();
    // Only the last two survive — the sourceId "tmux" defaults to operational.
    const replay = bus.replay(0);
    assert.deepEqual(
      replay.events.map((e) => e.seq),
      [2, 3],
    );
    assert.equal(bus.protectedCount(), 0);
  } finally { await cleanup(); }
});

test("pending-decision entries are kept past the limit", async () => {
  const { bus, cleanup } = await makeBus(2);
  try {
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({
      type: "dispatch.ambiguous",
      sourceId: "runtime/dispatcher.decision",
      data: { invocationId: crypto.randomUUID(), reason: "tie" },
    });
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.flush();
    // Operational entries should be limited to the last 2; the
    // pending-decision entry (seq 2) must survive.
    const replay = bus.replay(0);
    const seqs = replay.events.map((e) => e.seq);
    assert.equal(seqs.includes(2), true);
    assert.equal(bus.protectedCount(), 1);
  } finally { await cleanup(); }
});

test("live-intent and recoverable-candidate entries also survive the cap", async () => {
  const { bus, cleanup } = await makeBus(1);
  try {
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({
      type: "stop.requested",
      sourceId: "runtime/dispatcher.intent",
      data: { runId: crypto.randomUUID(), reason: "user-stop", requestedBy: "test" },
    });
    await bus.publish({
      type: "settings-changed",
      sourceId: "runtime/backup.candidate",
      data: {},
    });
    await bus.flush();
    // Operational entries (seq 1, 3) are sliced to the last 1 (seq 3);
    // protected entries (seq 2 live-intent, seq 3 was reassigned to
    // recoverable-candidate and survives by class) — but seq 3 is also
    // "operational" up to the slice and still wins the last-1 slot.
    // The contract: anything tagged protected survives. Two protected
    // events => protectedCount === 2.
    const replay = bus.replay(0);
    const seqs = replay.events.map((e) => e.seq);
    assert.equal(seqs.includes(2), true);
    assert.equal(bus.protectedCount(), 2);
  } finally { await cleanup(); }
});

test("rotation interaction: protected entries from a previous slice survive when the limit kicks in", async () => {
  const { bus, cleanup } = await makeBus(2);
  try {
    // Publish 3 protected entries interleaved with operational ones.
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({
      type: "dispatch.ambiguous",
      sourceId: "runtime/dispatcher.decision",
      data: { invocationId: crypto.randomUUID(), reason: "tie" },
    });
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.publish({
      type: "dispatch.ambiguous",
      sourceId: "runtime/dispatcher.decision",
      data: { invocationId: crypto.randomUUID(), reason: "tie" },
    });
    await bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} });
    await bus.flush();
    // Operational events get sliced to the last 2 (seq 4, 5).
    // Protected events (seq 2, 4) survive.
    const replay = bus.replay(0);
    const seqs = replay.events.map((e) => e.seq);
    assert.equal(seqs.includes(2), true);
    assert.equal(seqs.includes(4), true);
    assert.equal(bus.protectedCount(), 2);
  } finally { await cleanup(); }
});
