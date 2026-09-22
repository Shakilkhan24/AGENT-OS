/**
 * M9.3 — global keyboard shortcuts.
 *
 * Wires the four M5.6-deferred hotkeys at the App root:
 *
 * - `Ctrl+Shift+P` — open the command palette. Stays global even when an
 *   input/textarea has focus, because the palette *is* a text input itself.
 * - `Ctrl+Shift+S` — toggle the managed/sidebar split (advanced).
 * - `Ctrl+Shift+ArrowUp` / `Ctrl+Shift+ArrowDown` — cycle keyboard focus
 *   through the chrome panes (sidebar → terminal panel → inbox → back).
 * - `?` — open the keyboard cheatsheet dialog. Skipped inside text inputs.
 *
 * The hook deliberately bails when the active element is inside a terminal
 * surface (`.terminal-surface` / `.xterm*`), so xterm.js receives the key
 * unaltered for AT or its own keybindings. The only exception is
 * `Ctrl+Shift+P`, which intentionally still fires globally so a user
 * inside a terminal can summon the palette without first clicking out.
 */
import { useEffect } from "react";

export interface GlobalShortcuts {
  /** Ctrl+Shift+P — opens the command palette. */
  onPalette(): void;
  /** Ctrl+Shift+S — toggles managed mode. */
  onSplitter(): void;
  /** Ctrl+Shift+ArrowUp/Down — focus cycle. */
  onFocusCycle(direction: "up" | "down"): void;
  /** `?` — opens the keyboard cheatsheet. */
  onCheatsheet(): void;
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

/** True if the event target lives inside an attached terminal surface. */
function isInsideTerminal(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest(".terminal-surface, .xterm, .xterm-helper-textarea"));
}

export function useGlobalShortcuts(shortcuts: GlobalShortcuts): void {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const mod = event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey;
      // `?` is Shift+/ on US layouts; some layouts need other combos, so we
      // also accept `Shift+/` directly. We bail inside text inputs.
      const isQuestion = event.key === "?";
      const isShiftSlash = event.key === "/" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
      if (!mod) {
        if ((isQuestion || isShiftSlash) && !isTextInput(event.target)) {
          event.preventDefault();
          shortcuts.onCheatsheet();
        }
        return;
      }
      const key = event.key.toLowerCase();
      // Ctrl+Shift+P stays global even when an input has focus (the palette
      // IS a text input). xterm.js does not consume Ctrl+Shift+P, so we let
      // it through inside a terminal too.
      if (key === "p") {
        event.preventDefault();
        shortcuts.onPalette();
        return;
      }
      // Everything else: bail on text inputs AND inside terminals.
      if (isTextInput(event.target) || isInsideTerminal(event.target)) return;
      if (key === "s") {
        event.preventDefault();
        shortcuts.onSplitter();
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        shortcuts.onFocusCycle("up");
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        shortcuts.onFocusCycle("down");
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [shortcuts]);
}
