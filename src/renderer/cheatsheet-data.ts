/**
 * M9.3 — keyboard cheatsheet contents.
 *
 * The cheatsheet data is a plain array so a test can assert the table
 * contents without rendering the dialog. The dialog component
 * (`KeyboardCheatsheet.tsx`) just maps over this list.
 */
export interface CheatsheetEntry {
  /** What the user presses. Display as the key-combo column. */
  readonly keys: string;
  /** Short, plain-English description of the effect. */
  readonly description: string;
  /** Optional scope (e.g. "global", "tabs", "dialog"). */
  readonly scope?: string;
}

export const CHEATSHEET: readonly CheatsheetEntry[] = [
  { keys: "Ctrl+Shift+P", description: "Open the command palette", scope: "global" },
  { keys: "Ctrl+Shift+S", description: "Toggle managed review (advanced)", scope: "global" },
  { keys: "Ctrl+Shift+\u2191 / \u2193", description: "Cycle keyboard focus across panes", scope: "global" },
  { keys: "?", description: "Open this cheatsheet", scope: "global" },
  { keys: "Tab / Shift+Tab", description: "Cycle focus inside dialogs", scope: "dialog" },
  { keys: "Escape", description: "Close the current dialog", scope: "dialog" },
  { keys: "Enter", description: "Activate the focused button or row", scope: "global" },
  { keys: "\u2190 / \u2192", description: "Move between terminal tabs (roving)", scope: "tabs" },
  { keys: "Home / End", description: "Jump to first / last terminal tab", scope: "tabs" },
  { keys: "Ctrl+Shift+C / V", description: "Copy / paste a terminal selection", scope: "terminal" },
];
