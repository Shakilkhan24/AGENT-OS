import { memo, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { TerminalView } from "../shared/types";

function TerminalTabsImpl({
  terminals,
  selected,
  closing,
  select,
  close,
  add,
}: {
  terminals: TerminalView[];
  selected?: string;
  closing: Set<string>;
  select(id: string): void;
  close(id: string): void;
  add(): void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(selected);
  const tabStop = terminals.some(item => item.id === focused) ? focused : selected ?? terminals[0]?.id;
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const reveal = () =>
      element
        .querySelector('[aria-selected="true"]')
        ?.parentElement?.scrollIntoView({
          block: "nearest",
          inline: "nearest",
        });
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => observer.disconnect();
  }, [selected, terminals.length]);
  return (
    <div className="terminal-tabbar">
      <div
        ref={strip}
        className="terminal-tabs"
        role="tablist"
        aria-label="Terminals"
      >
        {terminals.map((item) => (
          <div
            key={item.id}
            className={`terminal-tab-group ${selected === item.id ? "active" : ""}`}
          >
            <button
              role="tab"
              tabIndex={tabStop === item.id ? 0 : -1}
              aria-selected={selected === item.id}
              className="terminal-tab"
              title={`${item.label} · ${item.status}\n${item.command || "Interactive shell"}`}
              onClick={() => select(item.id)}
              onFocus={() => setFocused(item.id)}
              onKeyDown={event => {
                const buttons = Array.from(strip.current!.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                const index = buttons.indexOf(event.currentTarget);
                const next = event.key === "ArrowRight" ? (index + 1) % buttons.length
                  : event.key === "ArrowLeft" ? (index + buttons.length - 1) % buttons.length
                  : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : undefined;
                if (next === undefined) return;
                event.preventDefault();
                buttons[next].focus();
                buttons[next].scrollIntoView({ block: "nearest", inline: "nearest" });
              }}
            >
              <span
                className={`dot ${item.status === "running" ? "live" : item.status === "exited" ? "exited" : ""}`}
              />
              <span>{item.label}</span>
            </button>
            <button
              className="tab-close"
              tabIndex={tabStop === item.id ? 0 : -1}
              aria-label={`Close ${item.label}`}
              title={`Stop and close ${item.label}`}
              disabled={closing.has(item.id) || item.deleting}
              onClick={() => close(item.id)}
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        className="new-terminal-button"
        aria-label="Add terminals"
        title="Launch more terminals in this session"
        onClick={add}
      >
        <Plus size={16} />
        New terminal
      </button>
    </div>
  );
}

/**
 * Memoized so the tab bar doesn't re-render when an unrelated part of the
 * snapshot changes (e.g. a status tick on a non-selected terminal). The
 * `terminals` array reference changes only when the underlying terminal
 * list mutates thanks to the shallow-equality guard in `useWorkspace`.
 */
export const TerminalTabs = memo(TerminalTabsImpl);
