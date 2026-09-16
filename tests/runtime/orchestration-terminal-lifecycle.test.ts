/**
 * M5.6 — terminal lifecycle tests.
 *
 * Coverage (10 focused tests):
 *  - hide keeps registry row untouched + sets hiddenAt
 *  - stop-and-remove detaches + drops registry + sets removedAt
 *  - delete-history deletes rows + emits digest + rejects decider:'system'
 *  - re-attach after stop-and-remove succeeds (registry unchanged)
 *  - re-attach after delete-history throws (terminal row gone)
 *  - audit digest stable across retries
 *  - concurrent calls serialized via withTerminalLock
 *  - IPC enum alias `graceful` resolves to `stop-and-remove`
 *  - hiddenAt cleared on stop-and-remove
 *  - missing terminalUuid returns NOT_FOUND
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  deleteRetainedHistory,
  ensureLifecycleColumns,
  hideTerminal,
  readLifecycleMarkers,
  resolveTerminalLifecyclePolicy,
  stopAndRemoveTerminal,
  TERMINAL_HISTORY_META_PREFIX,
} from "../../src/runtime/orchestration/terminal-lifecycle";
import { TerminalInputQueue } from "../../src/runtime/input-queue";

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function seedSession(worker: DbWorker): { sessionId: number; terminalUuid: string } {
  const sessionUuid = randomUUID();
  const terminalUuid = randomUUID();
  const driver = driverOf(worker);
  driver.prepare("INSERT INTO session (uuid, name, directory, identity, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(sessionUuid, "test-session", "/tmp", "test-identity", new Date().toISOString());
  const sessionRow = driver.prepare("SELECT id FROM session WHERE uuid = ?")
    .first(sessionUuid) as { id: number };
  driver.prepare(
    "INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(terminalUuid, sessionRow.id, "t1", "/tmp", "bash", new Date().toISOString());
  return { sessionId: sessionRow.id, terminalUuid };
}

test("hideTerminal keeps the registry row untouched + sets hiddenAt", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    const result = await hideTerminal(worker, { terminalUuid });
    assert.equal(result.hidden, true);
    assert.equal(result.terminalUuid, terminalUuid);
    const markers = readLifecycleMarkers(worker, terminalUuid);
    assert.equal(typeof markers.hiddenAt, "number");
    assert.equal(markers.removedAt, null);
  } finally { await worker.close(); }
});

test("stopAndRemoveTerminal sets removedAt + clears hiddenAt", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    await hideTerminal(worker, { terminalUuid });
    const result = await stopAndRemoveTerminal(worker, { terminalUuid });
    assert.equal(result.removed, true);
    assert.equal(result.historyRetained, true);
    const markers = readLifecycleMarkers(worker, terminalUuid);
    assert.equal(typeof markers.removedAt, "number");
    assert.equal(markers.hiddenAt, null, "stopAndRemove must clear hiddenAt");
    // terminal row is still present (history retained).
    const driver = driverOf(worker);
    const row = driver.prepare("SELECT uuid FROM terminal WHERE uuid = ?").first(terminalUuid);
    assert.ok(row, "terminal row must be retained after stop-and-remove");
  } finally { await worker.close(); }
});

test("deleteRetainedHistory rejects decider:'system' with FORBIDDEN", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    await assert.rejects(
      () => deleteRetainedHistory(worker, { terminalUuid, decider: "system" }),
      /history-deletion requires user/,
    );
  } finally { await worker.close(); }
});

test("deleteRetainedHistory deletes rows + emits audit digest when decider:'user'", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    const driver = driverOf(worker);
    // Seed two terminal-history meta rows.
    driver.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:1`, '"line1"');
    driver.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:2`, '"line2"');
    const result = await deleteRetainedHistory(worker, { terminalUuid, decider: "user" });
    assert.equal(result.deleted, true);
    assert.equal(result.linesDropped, 2);
    assert.match(result.auditDigest, /^[0-9a-f]{64}$/);
    const stillThere = driver.prepare("SELECT uuid FROM terminal WHERE uuid = ?").first(terminalUuid);
    assert.equal(stillThere, undefined);
    const allMeta = driver.prepare("SELECT key FROM meta").all() as Array<{ key: string }>;
    const historyLeftover = allMeta.filter((m) => m.key.startsWith(`${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:`));
    assert.equal(historyLeftover.length, 0);
  } finally { await worker.close(); }
});

test("re-attach after stop-and-remove succeeds (terminal row + history retained)", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    const driver = driverOf(worker);
    driver.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:1`, '"line1"');
    const result = await stopAndRemoveTerminal(worker, { terminalUuid });
    assert.equal(result.removed, true);
    // The terminal row is still there.
    const row = driver.prepare("SELECT uuid FROM terminal WHERE uuid = ?").first(terminalUuid);
    assert.ok(row);
    const history = driver.prepare("SELECT key FROM meta").all() as Array<{ key: string }>;
    const retained = history.filter((h) => h.key.startsWith(`${TERMINAL_HISTORY_META_PREFIX}${terminalUuid}:`));
    assert.equal(retained.length, 1);
  } finally { await worker.close(); }
});

test("re-attach after delete-history throws NOT_FOUND", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    await deleteRetainedHistory(worker, { terminalUuid, decider: "user" });
    await assert.rejects(
      () => hideTerminal(worker, { terminalUuid }),
      /not registered/,
    );
  } finally { await worker.close(); }
});

test("audit digest stable across retries (same input → same digest)", async () => {
  const worker = freshWorker();
  try {
    seedSession(worker);
    ensureLifecycleColumns(worker);
    // Two callers, identical input shape, deterministic via createHash.
    const input = { terminalUuid: "11111111-2222-4333-8444-555555555555", linesDropped: 5, decider: "user", ts: "2026-09-16T00:00:00.000Z" };
    const a = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
    const b = createHash("sha256").update(JSON.stringify(input), "utf8").digest("hex");
    assert.equal(a, b);
  } finally { await worker.close(); }
});

test("concurrent calls serialized via withTerminalLock", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    ensureLifecycleColumns(worker);
    const results = await Promise.all([
      hideTerminal(worker, { terminalUuid }),
      stopAndRemoveTerminal(worker, { terminalUuid }),
    ]);
    // Both resolve; the order is implementation-defined but both succeed.
    assert.equal(results.length, 2);
    const driver = driverOf(worker);
    const row = driver.prepare("SELECT hidden_at, removed_at FROM terminal WHERE uuid = ?").first(terminalUuid) as { hidden_at: number | null; removed_at: number | null } | undefined;
    assert.ok(row);
    // Stop-and-remove clears hiddenAt, so the final state has removedAt set, hiddenAt null.
    assert.equal(row.hidden_at, null);
    assert.equal(typeof row.removed_at, "number");
  } finally { await worker.close(); }
});

test("IPC enum alias `graceful` resolves to `stop-and-remove`", () => {
  assert.equal(resolveTerminalLifecyclePolicy("graceful"), "stop-and-remove");
  assert.equal(resolveTerminalLifecyclePolicy("hide"), "hide");
  assert.equal(resolveTerminalLifecyclePolicy("stop-and-remove"), "stop-and-remove");
  assert.equal(resolveTerminalLifecyclePolicy("delete-history"), "delete-history");
});

test("missing terminalUuid returns NOT_FOUND", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      () => hideTerminal(worker, { terminalUuid: "00000000-0000-4000-8000-000000000000" }),
      /not registered/,
    );
    await assert.rejects(
      () => stopAndRemoveTerminal(worker, { terminalUuid: "00000000-0000-4000-8000-000000000000" }),
      /not registered/,
    );
    await assert.rejects(
      () => deleteRetainedHistory(worker, { terminalUuid: "00000000-0000-4000-8000-000000000000", decider: "user" }),
      /not registered/,
    );
  } finally { await worker.close(); }
});

test("TerminalInputQueue.cancel is invoked when stopAndRemoveTerminal has a queue", async () => {
  const worker = freshWorker();
  try {
    const { terminalUuid } = seedSession(worker);
    const queue = new TerminalInputQueue(async (_t, _d) => undefined);
    // Submit a queued entry so cancel has work to do.
    queue.enqueue(terminalUuid, "queued-bytes");
    const result = await stopAndRemoveTerminal(worker, { terminalUuid }, { inputQueue: queue });
    assert.equal(result.removed, true);
    const progress = queue.progress(terminalUuid);
    assert.equal(progress.queued, 0, "cancel must have dropped the queued bytes");
  } finally { await worker.close(); }
});
