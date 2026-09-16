/**
 * M5.6 — pane layout pure logic (testable without a DOM).
 *
 * The layout state machine (split on/off, ratio clamp, focus cycle,
 * drag-handler ratio updates) is split out of the React component so
 * tests can exercise every branch deterministically. The React layer
 * (`PaneLayout.tsx`) imports `paneMachine` from here.
 */
import type { PaneState, SavedLayout, SplitConfig } from "../shared/workspace6-schema";

export interface PaneMachineState {
  readonly layout: SavedLayout;
  readonly focusedPaneId: "top" | "bottom";
}

export const PANE_RATIO_MIN = 0.1;
export const PANE_RATIO_MAX = 0.9;

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function withLayout(layout: SavedLayout, patch: { split?: Partial<SplitConfig>; top?: Partial<PaneState>; bottom?: Partial<PaneState> }): SavedLayout {
  return {
    ...layout,
    split: { ...layout.split, ...(patch.split ?? {}) },
    top: { ...layout.top, ...(patch.top ?? {}) },
    bottom: { ...layout.bottom, ...(patch.bottom ?? {}) },
  };
}

export function initialPaneMachine(layout: SavedLayout): PaneMachineState {
  // Default focus on top; if split is disabled the renderer still tracks focus
  // (it just doesn't render the unfocused pane separately).
  return { layout, focusedPaneId: "top" };
}

/** Toggle the split on/off. When turning on, keeps the current ratio. */
export function toggleSplit(state: PaneMachineState): PaneMachineState {
  const nextEnabled = !state.layout.split.enabled;
  return { layout: withLayout(state.layout, { split: { enabled: nextEnabled } }), focusedPaneId: state.focusedPaneId };
}

/** Cycle focus top ↔ bottom. When the split is disabled, focus is a no-op. */
export function cycleFocus(state: PaneMachineState): PaneMachineState {
  if (!state.layout.split.enabled) return state;
  return { ...state, focusedPaneId: state.focusedPaneId === "top" ? "bottom" : "top" };
}

/** Apply a drag-move ratio (already computed by the pointer handler). */
export function setRatio(state: PaneMachineState, ratio: number): PaneMachineState {
  return { ...state, layout: withLayout(state.layout, { split: { ratio: clamp(ratio, PANE_RATIO_MIN, PANE_RATIO_MAX) } }) };
}

/** Select a terminal in the focused pane. */
export function selectInFocusedPane(state: PaneMachineState, terminalId: string | null): PaneMachineState {
  const pane = state.focusedPaneId;
  return { ...state, layout: withLayout(state.layout, { [pane]: { activeTerminalId: terminalId } }) };
}

/** Hide a terminal — keeps the row in `hiddenTerminalIds` of the targeted pane. */
export function hideTerminal(state: PaneMachineState, terminalId: string, paneId: "top" | "bottom"): PaneMachineState {
  const pane = state.layout[paneId];
  const hidden = pane.hiddenTerminalIds.includes(terminalId)
    ? pane.hiddenTerminalIds
    : [...pane.hiddenTerminalIds, terminalId];
  return {
    ...state,
    layout: withLayout(state.layout, {
      [paneId]: { hiddenTerminalIds: hidden, activeTerminalId: pane.activeTerminalId === terminalId ? null : pane.activeTerminalId },
    }),
  };
}
