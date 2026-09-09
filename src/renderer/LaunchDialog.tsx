import { useState } from "react";
import { Play, TerminalSquare } from "lucide-react";
import type { LaunchRequest, Preset } from "../shared/types";
import { commandLabel } from "../shared/commands";
import { Field, Modal } from "./components";

export function LaunchDialog({
  presets,
  initial,
  busy,
  error,
  close,
  launch,
}: {
  presets: Preset[];
  initial: LaunchRequest;
  busy: boolean;
  error: string;
  close(): void;
  launch(request: LaunchRequest): Promise<void>;
}) {
  const [command, setCommand] = useState(initial.command || "");
  const [presetId, setPresetId] = useState(
    presets.find((p) => p.command === (initial.command || ""))?.id || "",
  );
  const [label, setLabel] = useState(initial.label || "");
  const [labelEdited, setLabelEdited] = useState(false);
  const [count, setCount] = useState(1);
  const [cwd, setCwd] = useState(initial.cwd || "");
  const [savePreset, setSavePreset] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    void launch({
      command,
      label,
      count,
      cwd,
      ...(savePreset
        ? { savePresetAs: label.trim() || commandLabel(command) }
        : {}),
    });
  };
  return (
    <Modal
      title="Launch terminals"
      subtitle="Type the command you want each terminal to run."
      close={close}
      busy={busy}
      error={error}
    >
      <form onSubmit={submit}>
        <Field
          label="Command"
          hint="For example: codex, claude, opencode, or pi. Leave blank for a plain shell."
        >
          <textarea
            className="launch-command"
            name="command"
            rows={2}
            autoFocus
            spellCheck={false}
            maxLength={8192}
            placeholder="codex"
            value={command}
            onChange={(event) => {
              setCommand(event.target.value);
              setPresetId("");
              if (!labelEdited) setLabel("");
            }}
          />
        </Field>
        <Field
          label="Workflow preset"
          hint="Optional. Choose a saved workflow, then edit its command if needed."
        >
          <select
            value={presetId}
            onChange={(event) => {
              setPresetId(event.target.value);
              const preset = presets.find((p) => p.id === event.target.value);
              if (preset) {
                setCommand(preset.command);
                setLabel(preset.name);
                setLabelEdited(false);
              }
            }}
          >
            <option value="">Custom command</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.command
                  ? ` — ${p.command.slice(0, 50)}`
                  : " — interactive shell"}
              </option>
            ))}
          </select>
        </Field>
        <div className="field-grid">
          <Field label="Number of terminals">
            <input
              name="count"
              type="number"
              min={1}
              max={32}
              required
              value={Number.isNaN(count) ? "" : count}
              onChange={(event) => setCount(event.target.valueAsNumber)}
            />
          </Field>
          <Field label="Terminal label" hint="A number is added to each label.">
            <input
              maxLength={70}
              value={label}
              placeholder={commandLabel(command)}
              onChange={(event) => {
                setLabel(event.target.value);
                setLabelEdited(true);
              }}
            />
          </Field>
        </div>
        <Field
          label="Working subdirectory"
          hint="Relative to the session folder."
        >
          <input
            name="cwd"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder=". (session root)"
            maxLength={4096}
          />
        </Field>
        <label className="check-field">
          <input
            type="checkbox"
            checked={savePreset}
            onChange={(event) => setSavePreset(event.target.checked)}
          />
          Save this command as a preset
        </label>
        <p className="form-note">
          <TerminalSquare size={15} />
          Add more at any time with + New terminal. Close any tab with ×.
        </p>
        <div className="modal-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            <Play size={14} />
            {busy
              ? "Launching…"
              : `Launch ${Number.isNaN(count) ? "" : count} terminal${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </form>
    </Modal>
  );
}
