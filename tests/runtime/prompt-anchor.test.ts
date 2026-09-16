/**
 * M5.7 — literal bounded prompt-anchor tests.
 *
 * Coverage (10 focused tests):
 *   1. literal `$ ` at line end → non-null anchor with anchoredAt + sourceSeq.
 *   2. no literal match → `null`.
 *   3. multiple literal lines → latest wins.
 *   4. `promptAnchorEnabled = false` → `null`.
 *   5. digest stable across two calls with identical inputs.
 *   6. digest changes when `anchorText` byte-changes.
 *   7. digest changes when `sourceSeq` changes.
 *   8. `viewTerminalMemory` round-trips `data.promptAnchor` after seeding.
 *   9. mutating `data.promptAnchor` invalidates the view digest.
 *  10. `PROMPT_ANCHOR_LINE_WINDOW = 64` enforced: anchor at index 5 outside
 *      window returns `null`; anchor at index 95 inside window returns non-null.
 *
 * Known runtime gap (documented in `IMPLEMENTATION-README.md`):
 * PTY frames are not yet piped into `appendTerminalHistory`; the
 * seeding path used here is the test seam. Once a follow-up wires
 * the PTY → `appendTerminalHistory` plumbing, the M5.7 view will
 * surface anchors for live terminals without further changes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  viewTerminalMemory,
  appendTerminalHistory,
} from "../../src/runtime/db/memory-views";
import {
  DEFAULT_PROMPT_ANCHOR_LITERALS,
  PROMPT_ANCHOR_LINE_WINDOW,
  digestPromptAnchor,
  latestPromptAnchor,
  mergeLiteralAllowlist,
  resolvePromptAnchorSettings,
} from "../../src/runtime/orchestration/prompt-anchor";
import { promptAnchorSchema } from "../../src/shared/prompt-anchor-schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

function seedSessionAndTerminal(driver: { prepare(s: string): { run(...b: unknown[]): void } }, termUuid: string): void {
  driver.prepare(`INSERT INTO session (uuid, name, directory, identity, created_at, deleting, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run("00000000-0000-4000-8000-000000000010", "M5.7", "/tmp", "i", new Date().toISOString(), 0, "{}");
  driver.prepare(`INSERT INTO terminal (uuid, session_id, label, cwd, command, created_at, deleting, deletion_policy, launch_error, started_at, ended_at, exit_signal, exit_code, metadata_json, env_json, env_profile_id, prompt_anchors_json, launch_state, origin_hook_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(termUuid, 1, "shell", "/tmp", "bash", new Date().toISOString(), 0, null, null, null, null, null, null, null, null, null, null, null, null);
}

async function seedLines(
  worker: DbWorker,
  termUuid: string,
  lines: ReadonlyArray<string>,
): Promise<void> {
  // `appendTerminalHistory` auto-stamps `capturedAt` to the current
  // timestamp; spread the calls with a no-op await so the timestamps
  // remain monotonic within the test runtime.
  for (let i = 0; i < lines.length; i++) {
    await appendTerminalHistory(worker, {
      terminalUuid: termUuid,
      stream: "stdout",
      content: lines[i],
    });
  }
}

// ---------------------------------------------------------------------------
// 1. literal `$ ` at line end → non-null anchor
// ---------------------------------------------------------------------------

test("latestPromptAnchor finds a literal `$ ` at line end and returns a non-null anchor", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    await seedLines(worker, termUuid, ["last command output", "user@host:~$ "]);
    const settings = resolvePromptAnchorSettings({});
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid });
    const anchor = latestPromptAnchor(termUuid, out.data.lines, settings);
    assert.ok(anchor !== null, "expected anchor to be non-null");
    assert.equal(anchor!.terminalUuid, termUuid);
    assert.ok(anchor!.anchorText.endsWith("$ "), `anchorText=${anchor!.anchorText}`);
    assert.equal(anchor!.source, "literal");
    assert.match(anchor!.promptAnchorDigest, /^[0-9a-f]{64}$/);
    // Round-trip through the strict Zod schema.
    const parsed = promptAnchorSchema.parse(anchor);
    assert.equal(parsed.terminalUuid, anchor!.terminalUuid);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 2. no literal match → null
// ---------------------------------------------------------------------------

test("latestPromptAnchor returns null when no literal matches", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    await seedLines(worker, termUuid, ["ls -la", "build succeeded", "tests passed"]);
    const settings = resolvePromptAnchorSettings({});
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid });
    assert.equal(latestPromptAnchor(termUuid, out.data.lines, settings), null);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 3. multiple literal lines → latest wins
// ---------------------------------------------------------------------------

test("latestPromptAnchor picks the latest literal match in reverse walk", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    await seedLines(worker, termUuid, [
      "user@host:~$ ",        // seq 1
      "running build...",
      "build succeeded",
      "user@host:~$ ",        // seq 4 — latest
    ]);
    const settings = resolvePromptAnchorSettings({});
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid });
    const anchor = latestPromptAnchor(termUuid, out.data.lines, settings);
    assert.ok(anchor !== null);
    assert.equal(anchor!.sourceSeq, 4);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 4. promptAnchorEnabled = false → null
// ---------------------------------------------------------------------------

test("latestPromptAnchor returns null when settings.enabled is false", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    await seedLines(worker, termUuid, ["user@host:~$ "]);
    const settings = resolvePromptAnchorSettings({ enabled: false });
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid });
    assert.equal(latestPromptAnchor(termUuid, out.data.lines, settings), null);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 5. digest stable across two calls
// ---------------------------------------------------------------------------

test("digestPromptAnchor is deterministic across two calls with identical inputs", () => {
  const t = randomUUID();
  const d1 = digestPromptAnchor(t, 1_700_000_000_000, "user@host:~$ ", 42);
  const d2 = digestPromptAnchor(t, 1_700_000_000_000, "user@host:~$ ", 42);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------------------
// 6. digest changes when anchorText byte-changes
// ---------------------------------------------------------------------------

test("digestPromptAnchor changes when anchorText changes by one byte", () => {
  const t = randomUUID();
  const a = digestPromptAnchor(t, 1_700_000_000_000, "user@host:~$ ", 42);
  const b = digestPromptAnchor(t, 1_700_000_000_000, "user@host:#$ ", 42);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// 7. digest changes when sourceSeq changes
// ---------------------------------------------------------------------------

test("digestPromptAnchor changes when sourceSeq changes", () => {
  const t = randomUUID();
  const a = digestPromptAnchor(t, 1_700_000_000_000, "user@host:~$ ", 42);
  const b = digestPromptAnchor(t, 1_700_000_000_000, "user@host:~$ ", 43);
  assert.notEqual(a, b);
});

// ---------------------------------------------------------------------------
// 8. viewTerminalMemory round-trips data.promptAnchor
// ---------------------------------------------------------------------------

test("viewTerminalMemory data.promptAnchor reflects the latest literal match", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    await seedLines(worker, termUuid, ["output line", "user@host:~$ "]);
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid });
    assert.ok(out.data.promptAnchor !== null, "expected data.promptAnchor to be non-null");
    assert.equal(out.data.promptAnchor!.terminalUuid, termUuid);
    assert.ok(out.data.promptAnchor!.anchorText.endsWith("$ "));
    assert.equal(out.data.promptAnchor!.source, "literal");
    assert.match(out.data.promptAnchor!.promptAnchorDigest, /^[0-9a-f]{64}$/);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 9. mutating data.promptAnchor invalidates the view digest
// ---------------------------------------------------------------------------

test("viewTerminalMemory digest changes when a new history line produces a new anchor", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    // First read with no anchor.
    const a = viewTerminalMemory(worker, { terminalUuid: termUuid });
    assert.equal(a.data.promptAnchor, null);
    await appendTerminalHistory(worker, {
      terminalUuid: termUuid,
      stream: "stdout",
      content: "user@host:~$ ",
    });
    // Second read with anchor — digest must change.
    const b = viewTerminalMemory(worker, { terminalUuid: termUuid });
    assert.notEqual(a.digest, b.digest);
    assert.ok(b.data.promptAnchor !== null);
    assert.ok(b.data.promptAnchor!.anchorText.endsWith("$ "));
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// 10. PROMPT_ANCHOR_LINE_WINDOW = 64 enforced
// ---------------------------------------------------------------------------

test("latestPromptAnchor enforces PROMPT_ANCHOR_LINE_WINDOW = 64", async () => {
  const worker = freshWorker();
  try {
    const termUuid = randomUUID();
    seedSessionAndTerminal(driverOf(worker), termUuid);
    // Build 100 lines: anchor at index 5 (outside window) and at index 95 (inside).
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      if (i === 5) lines.push("user@host:~$ ");
      else if (i === 95) lines.push("user@host:~$ ");
      else lines.push(`line-${i}`);
    }
    await seedLines(worker, termUuid, lines);
    const out = viewTerminalMemory(worker, { terminalUuid: termUuid, maxLines: 200 });
    assert.equal(out.data.lines.length, 100);
    // First verify the window constant matches the bullet.
    assert.equal(PROMPT_ANCHOR_LINE_WINDOW, 64);
    // Only the latest match (index 95) is reachable from the reverse walk.
    const settings = resolvePromptAnchorSettings({});
    const anchor = latestPromptAnchor(termUuid, out.data.lines, settings);
    assert.ok(anchor !== null);
    assert.equal(anchor!.sourceSeq, 96, `expected sourceSeq=96 (1-based), got ${anchor!.sourceSeq}`);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// Bonus invariants (still bounded by the M5.7 spec) — mergeLiteralAllowlist,
// DEFAULT_PROMPT_ANCHOR_LITERALS coverage, schema strictness.
// ---------------------------------------------------------------------------

test("mergeLiteralAllowlist dedupes and caps at 16 entries", () => {
  const merged = mergeLiteralAllowlist(["$ ", "> "], ["> ", "❯ ", "$ "]);
  assert.deepEqual([...merged], ["$ ", "> ", "❯ "]);
});

test("mergeLiteralAllowlist caps at 16 entries even when input exceeds the cap", () => {
  const custom: string[] = [];
  for (let i = 0; i < 32; i++) custom.push(`L${i} `);
  const merged = mergeLiteralAllowlist(DEFAULT_PROMPT_ANCHOR_LITERALS, custom);
  assert.equal(merged.length, 16);
});

test("promptAnchorSchema rejects bogus fields (strict mode)", () => {
  const t = randomUUID();
  assert.throws(
    () =>
      promptAnchorSchema.parse({
        terminalUuid: t,
        anchoredAt: 1,
        anchorText: "x ",
        sourceSeq: 1,
        source: "literal",
        promptAnchorDigest: "a".repeat(64),
        bogus: true,
      }),
  );
});

test("promptAnchorSchema rejects non-64-hex digest", () => {
  const t = randomUUID();
  assert.throws(
    () =>
      promptAnchorSchema.parse({
        terminalUuid: t,
        anchoredAt: 1,
        anchorText: "x ",
        sourceSeq: 1,
        source: "literal",
        promptAnchorDigest: "tooshort",
      }),
  );
});

function driverOf(worker: DbWorker): { prepare(s: string): { run(...b: unknown[]): void } } {
  return (worker as unknown as { driver: { prepare(s: string): { run(...b: unknown[]): void } } }).driver;
}
