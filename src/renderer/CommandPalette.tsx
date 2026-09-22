/**
 * M9.3 — command palette dialog.
 *
 * Renders the existing `<Modal>` so focus restoration + Escape come for
 * free. The matching algorithm lives in `command-logic.ts` (M5.6) so the
 * same code path drives the UI and the unit tests.
 */
import { useMemo, useRef, useState, useEffect } from "react";
import { Modal } from "./components";
import {
  selectCommands,
  filterByScope,
  type PaletteCommand,
} from "./command-logic";

export interface PaletteAction {
  readonly command: PaletteCommand;
  /** Side effect to run when the user activates this command. */
  run(): void;
}

const RECENT_LIMIT = 5;
const RESULT_LIMIT = 12;

export function CommandPalette({
  commands,
  recentIds,
  runCommand,
  close,
  sessionFocused,
  terminalFocused,
}: {
  commands: readonly PaletteAction[];
  recentIds: readonly string[];
  runCommand(command: PaletteCommand): void;
  close(): void;
  sessionFocused: boolean;
  terminalFocused: boolean;
}) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scoped = useMemo(
    () =>
      filterByScope(
        commands.map((c) => c.command),
        { sessionFocused, terminalFocused },
      ).map((c) => commands.find((a) => a.command.id === c.id)!).filter(Boolean),
    [commands, sessionFocused, terminalFocused],
  );
  const recent = useMemo(
    () => recentIds.map((id) => scoped.find((a) => a.command.id === id)).filter(Boolean) as PaletteAction[],
    [recentIds, scoped],
  );
  const results = useMemo(() => {
    const list = query.length > 0 ? scoped : [...recent, ...scoped.filter((a) => !recentIds.includes(a.command.id))];
    if (query.length > 0) {
      return selectCommands(list.map((a) => a.command), query, RESULT_LIMIT).map(
        (s) => list.find((a) => a.command.id === s.command.id)!,
      );
    }
    return list.slice(0, RESULT_LIMIT);
  }, [query, scoped, recent, recentIds]);
  useEffect(() => {
    setHighlight(0);
  }, [query]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlight((value) => Math.min(value + 1, results.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight((value) => Math.max(value - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const action = results[highlight];
      if (action) {
        runCommand(action.command);
      }
    }
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const action = results[highlight];
    if (action) runCommand(action.command);
  };
  return (
    <Modal title="Command palette" subtitle="Find an action quickly" close={close}>
      <form onSubmit={submit}>
        <label className="field">
          <span>Search</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a command name"
            aria-controls="command-palette-results"
            aria-activedescendant={
              results[highlight] ? `command-palette-result-${results[highlight].command.id}` : undefined
            }
          />
        </label>
        <ul
          id="command-palette-results"
          className="command-palette-results"
          role="listbox"
          aria-label="Matching commands"
        >
          {results.length === 0 ? (
            <li className="command-palette-empty">No matching commands</li>
          ) : (
            results.map((action, index) => (
              <li
                id={`command-palette-result-${action.command.id}`}
                key={action.command.id}
                role="option"
                aria-selected={index === highlight}
                className={`command-palette-row ${index === highlight ? "highlight" : ""}`}
                onMouseEnter={() => setHighlight(index)}
                onClick={() => runCommand(action.command)}
              >
                <span>{action.command.label}</span>
                {action.command.scope !== "global" ? (
                  <span className="command-palette-scope">{action.command.scope}</span>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </form>
      <div className="modal-actions">
        <span className="muted">Recent: {RECENT_LIMIT}</span>
        <button type="button" className="secondary" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  );
}
