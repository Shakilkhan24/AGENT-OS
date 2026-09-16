/**
 * M5.6 — command palette pure-logic tests.
 *
 * Coverage (7 focused tests):
 *  - scoreCommand: substring hit ranks lower (better) than later hit
 *  - scoreCommand: alias is searched in addition to label
 *  - selectCommands: empty query returns the "all" leaderboard (score 0)
 *  - selectCommands: top-N respects the limit
 *  - selectCommands: ties broken by id lexicographic order
 *  - filterByScope: terminal-scope commands hidden when no terminal focused
 *  - readRecentCommands / pushRecentCommand: LRU dedup at the head
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  type PaletteCommand,
  filterByScope,
  pushRecentCommand,
  readRecentCommands,
  scoreCommand,
  selectCommands,
} from "../../src/renderer/command-logic";

const cmds: PaletteCommand[] = [
  { id: "split.toggle", label: "Toggle split", aliases: ["split"], scope: "global" },
  { id: "session.archive", label: "Archive session", scope: "session" },
  { id: "terminal.hide", label: "Hide current terminal", aliases: ["hide"], scope: "terminal" },
  { id: "memory.view-task", label: "View task memory", scope: "session" },
];

test("scoreCommand: substring hit at index 0 ranks lower (better) than later hit", () => {
  const start = { id: "a", label: "Open launch dialog", scope: "global" as const };
  const later = { id: "b", label: "Please open this dialog", scope: "global" as const };
  const a = scoreCommand("open", start);
  const b = scoreCommand("open", later);
  assert.ok(a !== null && b !== null);
  assert.ok(a < b);
});

test("scoreCommand: alias is searched in addition to label", () => {
  const c = { id: "x", label: "Hide current terminal", aliases: ["hide"], scope: "terminal" as const };
  // "hide" matches the alias at index 0 — wins over the label substring.
  assert.equal(scoreCommand("hide", c), 0);
  // "terminal" is found in the label.
  assert.equal(scoreCommand("terminal", c), 13);
});

test("selectCommands: empty query returns the leaderboard with score 0", () => {
  const out = selectCommands(cmds, "", 50);
  assert.equal(out.length, cmds.length);
  for (const entry of out) assert.equal(entry.score, 0);
});

test("selectCommands: top-N respects the limit", () => {
  const out = selectCommands(cmds, "session", 1);
  assert.equal(out.length, 1);
  // The only command with "session" in its label/alias is "session.archive".
  assert.equal(out[0].command.id, "session.archive");
});

test("selectCommands: ties broken by id lexicographic order", () => {
  const tied: PaletteCommand[] = [
    { id: "z.last", label: "Activate something", scope: "global" },
    { id: "a.first", label: "Activate whatever", scope: "global" },
  ];
  const out = selectCommands(tied, "activate", 50);
  assert.equal(out[0].command.id, "a.first");
  assert.equal(out[1].command.id, "z.last");
});

test("filterByScope: terminal-scope commands hidden when no terminal focused", () => {
  const filtered = filterByScope(cmds, { sessionFocused: true, terminalFocused: false });
  const ids = filtered.map((c) => c.id);
  assert.deepEqual(ids, ["split.toggle", "session.archive", "memory.view-task"]);
  // Terminal-scope command must NOT appear.
  assert.ok(!ids.includes("terminal.hide"));
});

test("filterByScope: terminal-scope commands appear when terminal focused", () => {
  const filtered = filterByScope(cmds, { sessionFocused: true, terminalFocused: true });
  const ids = filtered.map((c) => c.id);
  assert.ok(ids.includes("terminal.hide"));
});

test("readRecentCommands handles missing/empty/garbage input", () => {
  assert.deepEqual(readRecentCommands(null, 20), []);
  assert.deepEqual(readRecentCommands("", 20), []);
  assert.deepEqual(readRecentCommands("not-json", 20), []);
  assert.deepEqual(readRecentCommands("[1, 2]", 20), []);
});

test("pushRecentCommand dedupes + caps at limit", () => {
  const a = pushRecentCommand(null, "split.toggle", 5);
  const b = pushRecentCommand(a, "session.archive", 5);
  const c = pushRecentCommand(b, "split.toggle", 5); // re-use → head-of-list
  const d = pushRecentCommand(c, "memory.view-task", 5);
  const out = readRecentCommands(d, 5);
  assert.deepEqual(out, ["memory.view-task", "split.toggle", "session.archive"]);
});

test("pushRecentCommand caps at limit and drops the oldest tail", () => {
  let prev: string | null = null;
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    prev = pushRecentCommand(prev, id, 5);
  }
  const out = readRecentCommands(prev, 5);
  assert.deepEqual(out, ["f", "e", "d", "c", "b"]);
});
