import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBus } from "../src/main/event-bus";
test("event replay is bounded, ordered, durable and never triggers live subscribers", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root, 2);
  await bus.initialize();
  const seen: number[] = [];
  const off = bus.subscribe((event) => seen.push(event.seq));
  await Promise.all(
    Array.from({ length: 3 }, () =>
      bus.publish({ type: "engine-restored", sourceId: "tmux", data: {} }),
    ),
  );
  await bus.flush();
  assert.deepEqual(seen, [1, 2, 3]);
  off();
  const replay = bus.replay(0);
  assert.equal(replay.truncated, true);
  assert.deepEqual(
    replay.events.map((event) => event.seq),
    [2, 3],
  );
  assert.deepEqual(
    bus.replay(2).events.map((event) => event.seq),
    [3],
  );
  const reopened = new EventBus(root, 2);
  await reopened.initialize();
  assert.equal(
    (
      await reopened.publish({
        type: "settings-changed",
        sourceId: "settings",
        data: {},
      })
    ).seq,
    4,
  );
  assert.deepEqual(seen, [1, 2, 3]);
  await writeFile(bus.file, "{corrupt");
  await assert.rejects(new EventBus(root).initialize());
  assert.equal(await readFile(bus.file, "utf8"), "{corrupt");
});
test("event payloads and on-disk ordering are validated", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bus = new EventBus(root);
  await bus.initialize();
  await assert.rejects(
    bus.publish({
      type: "terminal-status",
      sourceId: "tmux",
      data: { status: "bad" },
    } as never),
  );
  const event = await bus.publish({
    type: "engine-restored",
    sourceId: "tmux",
    data: {},
  });
  await writeFile(
    bus.file,
    JSON.stringify({ version: 1, sequence: 1, events: [event, event] }),
  );
  await assert.rejects(new EventBus(root).initialize(), /sequence/);
});
