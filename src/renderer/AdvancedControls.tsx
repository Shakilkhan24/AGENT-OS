/**
 * M9.3 — Advanced controls gate.
 *
 * A `<details>` element rendered in the existing presets dialog. When the
 * toggle is on, the Managed-mode topbar toggle and hook-activation
 * affordances (M4.7) are surfaced. When off (default), they stay hidden
 * behind the `localStorage("minimal.advanced")` boolean.
 *
 * The persisted boolean is read on mount and on the `storage` event so
 * a second window reflects the same setting.
 */
import { useEffect, useState } from "react";

const STORAGE_KEY = "minimal.advanced";

function readFlag(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeFlag(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? "on" : "off");
  } catch {
    // localStorage may be disabled in some sandboxed contexts; the gate
    // simply defaults to "off" when persistence is unavailable.
  }
}

export function isAdvancedEnabled(): boolean {
  return readFlag();
}

export function AdvancedControls() {
  const [on, setOn] = useState<boolean>(readFlag);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY) setOn(readFlag());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const toggle = () => {
    const next = !on;
    writeFlag(next);
    setOn(next);
  };
  return (
    <details className="advanced-controls" open={on}>
      <summary>
        <span>Advanced controls</span>
        <span className="advanced-controls-state">{on ? "On" : "Off"}</span>
      </summary>
      <p className="advanced-controls-help">
        Turn on Managed review and provider/hook surfaces. Leave off if you
        mainly launch terminals from presets.
      </p>
      <button
        type="button"
        className="secondary"
        onClick={toggle}
        aria-pressed={on}
      >
        {on ? "Disable Advanced controls" : "Enable Advanced controls"}
      </button>
    </details>
  );
}