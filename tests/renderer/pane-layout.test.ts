/**
 * M5.6 — pane layout pure-logic tests.
 *
 * Coverage (6 focused tests):
 *  - toggleSplit turns split off → on and on → off
 *  - cycleFocus is a no-op when split disabled
 *  - cycleFocus alternates top ↔ bottom when split enabled
 *  - setRatio clamps to [0.1, 0.9]
 *  - selectInFocusedPane targets the focused pane
 *  - hideTerminal adds to hiddenTerminalIds + clears active if same id
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PANE_RATIO_MAX,
  PANE_RATIO_MIN,
  cycleFocus,
  hideTerminal,
  initialPaneMachine,
  selectInFocusedPane,
  setRatio,
  toggleSplit,
} from "../../src/renderer/pane-logic";
import {
  type SavedLayout,
} from "../../src/shared/workspace6-schema";

function emptyLayout(): SavedLayout {
  return {
    version: 3,
    sessionId: "11111111-2222-4333-8444-555555555555",
    split: { enabled: false, ratio: 0.5 },
    top: { activeTerminalId: null, hiddenTerminalIds: [] },
    bottom: { activeTerminalId: null, hiddenTerminalIds: [] },
    layoutDigest: "0".repeat(64),
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

test("toggleSplit turns split off → on and on → off", () => {
  let s = initialPaneMachine(emptyLayout());
  assert.equal(s.layout.split.enabled, false);
  s = toggleSplit(s);
  assert.equal(s.layout.split.enabled, true);
  s = toggleSplit(s);
  assert.equal(s.layout.split.enabled, false);
});

test("cycleFocus is a no-op when the split is disabled", () => {
  const s = initialPaneMachine(emptyLayout());
  const next = cycleFocus(s);
  assert.equal(next.focusedPaneId, s.focusedPaneId);
  assert.equal(next, s, "no-op should return the same reference");
});

test("cycleFocus alternates top ↔ bottom when the split is enabled", () => {
  let s = initialPaneMachine(emptyLayout());
  s = toggleSplit(s);
  assert.equal(s.focusedPaneId, "top");
  s = cycleFocus(s);
  assert.equal(s.focusedPaneId, "bottom");
  s = cycleFocus(s);
  assert.equal(s.focusedPaneId, "top");
});

test("setRatio clamps to [PANE_RATIO_MIN, PANE_RATIO_MAX]", () => {
  const base = initialPaneMachine(emptyLayout());
  assert.equal(setRatio(base, -1).layout.split.ratio, PANE_RATIO_MIN);
  assert.equal(setRatio(base, 2).layout.split.ratio, PANE_RATIO_MAX);
  assert.equal(setRatio(base, 0.5).layout.split.ratio, 0.5);
});

test("selectInFocusedPane targets the focused pane", () => {
  const s = toggleSplit(initialPaneMachine(emptyLayout()));
  // Initial focus is "top".
  const next = selectInFocusedPane(s, "terminal-A");
  assert.equal(next.layout.top.activeTerminalId, "terminal-A");
  assert.equal(next.layout.bottom.activeTerminalId, null);
});

test("hideTerminal adds to hiddenTerminalIds + clears active when same id", () => {
  let s = toggleSplit(initialPaneMachine(emptyLayout()));
  s = selectInFocusedPane(s, "terminal-A");
  const hidden = hideTerminal(s, "terminal-A", "top");
  assert.deepEqual(hidden.layout.top.hiddenTerminalIds, ["terminal-A"]);
  assert.equal(hidden.layout.top.activeTerminalId, null);
  // Hiding a different id should leave activeTerminalId alone.
  const noop = hideTerminal(s, "terminal-B", "top");
  assert.equal(noop.layout.top.activeTerminalId, "terminal-A");
  assert.deepEqual(noop.layout.top.hiddenTerminalIds, ["terminal-B"]);
});

test("hideTerminal is idempotent on the same terminalId", () => {
  let s = toggleSplit(initialPaneMachine(emptyLayout()));
  s = selectInFocusedPane(s, "terminal-A");
  const a = hideTerminal(s, "terminal-A", "top");
  const b = hideTerminal(a, "terminal-A", "top");
  assert.deepEqual(b.layout.top.hiddenTerminalIds, ["terminal-A"]);
});
