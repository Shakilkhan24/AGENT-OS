import type { Dispatch, FormEvent, SetStateAction } from "react";
import { Check, FolderOpen, Plus, X } from "lucide-react";
import type { Preset } from "../shared/types";
import { Field, Modal } from "./components";

export type Dialog = "create" | "rename" | "delete" | "launch" | "terminal-name" | "presets" | "help";
export function WorkspaceDialog({ dialog, busy, error, close, submit, sessionName, terminalLabel,
  directory, setDirectory, draftPresets, setDraftPresets, report }: {
  dialog: Exclude<Dialog, "launch">;
  busy: boolean;
  error: string;
  close(): void;
  submit(event: FormEvent<HTMLFormElement>): Promise<void>;
  sessionName?: string;
  terminalLabel?: string;
  directory: string;
  setDirectory(value: string): void;
  draftPresets: Preset[];
  setDraftPresets: Dispatch<SetStateAction<Preset[]>>;
  report(error: unknown): void;
}) {
  return (
    <Modal
      title={
        {
          create: "Create a session",
          rename: "Rename session",
          delete: "Delete this session?",
          "terminal-name": "Rename terminal",
          presets: "Launch presets",
          help: "A home for running work.",
        }[dialog]
      }
      subtitle={
        {
          create: "Bind a project directory to a persistent workspace.",
          rename: "Make this workspace easy to recognize.",
          delete:
            "All terminals in this session will be stopped. Project files will be kept.",
          "terminal-name": "A label that tells you what is running.",
          presets: "Your tools, your commands. Add any workflow you use.",
          help: "A few things to help you feel at home.",
        }[dialog]
      }
      close={close}
      busy={busy}
      error={error}
    >
      {dialog === "help" ? (
        <div className="help-content">
          <p>
            <strong>Sessions organize a folder and its terminals.</strong>{" "}
            Switch freely between projects. Running work continues in the
            background.
          </p>
          <p>
            <strong>Closing the window detaches the view.</strong> Processes
            and terminal history live in a private tmux server. Reopening
            reconnects to surviving work. A reboot or stopped WSL instance
            ends those processes; missing terminals are shown without
            rerunning commands.
          </p>
          <p>
            <strong>Launch any command.</strong> Enter codex, claude,
            opencode, pi, or any installed command. Leave it empty for a
            Bash shell. Save commands as presets and launch up to 32
            terminals at once.
          </p>
          <p>
            <strong>Add and close terminals freely.</strong> Use + New
            terminal at any time. Each tab’s × stops and removes just that
            terminal. Edit &amp; run opens its command for another launch.
            Reconnect restores a terminal connection without restarting its
            process.
          </p>
          <p>
            <strong>The explorer stays inside your session folder.</strong>{" "}
            Double-click to open folders or text files. Select an item to
            rename, move, or delete it. Symlinks and special files are
            blocked. Terminal commands run with your normal user
            permissions.
          </p>
          <p>
            <strong>Terminal basics.</strong> Type normally, use Ctrl+C to
            interrupt, and scroll with the mouse wheel. Ctrl+Shift+C /
            Ctrl+Shift+V copy and paste; right-click pastes.
          </p>
          <button className="primary" onClick={close}>
            Got it
            <Check size={15} />
          </button>
        </div>
      ) : (
        <form onSubmit={submit}>
          {(dialog === "create" ||
            dialog === "rename" ||
            dialog === "terminal-name") && (
            <Field label="Name">
              <input
                name="name"
                autoFocus
                required
                maxLength={80}
                placeholder={
                  dialog === "create" ? "e.g. Studio website" : ""
                }
                defaultValue={
                  dialog === "rename"
                    ? sessionName
                    : dialog === "terminal-name"
                      ? terminalLabel
                      : ""
                }
              />
            </Field>
          )}
          {dialog === "create" && (
            <Field
              label="Working directory"
              hint="Choose the folder this session can browse and manage."
            >
              <div className="directory-input">
                <input
                  required
                  value={directory}
                  onChange={(event) => setDirectory(event.target.value)}
                  placeholder="/home/you/projects/my-project"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={async () => {
                    try {
                      const value = await window.minimal.chooseDirectory();
                      if (value) setDirectory(value);
                    } catch (error) {
                      report(error);
                    }
                  }}
                >
                  <FolderOpen size={16} />
                  Browse
                </button>
              </div>
            </Field>
          )}
          {dialog === "presets" && (
            <div className="presets-editor">
              {draftPresets.map((preset, index) => (
                <div className="preset-row" key={preset.id}>
                  <div className="preset-number">
                    {String(index + 1).padStart(2, "0")}
                  </div>
                  <div>
                    <input
                      aria-label={`Preset ${index + 1} name`}
                      required
                      maxLength={70}
                      value={preset.name}
                      placeholder="Workflow name"
                      onChange={(event) =>
                        setDraftPresets((items) =>
                          items.map((p) =>
                            p.id === preset.id
                              ? { ...p, name: event.target.value }
                              : p,
                          ),
                        )
                      }
                    />
                    <textarea
                      aria-label={`Preset ${index + 1} command`}
                      rows={2}
                      maxLength={8192}
                      value={preset.command}
                      placeholder="Empty = interactive Bash shell"
                      spellCheck={false}
                      onChange={(event) =>
                        setDraftPresets((items) =>
                          items.map((p) =>
                            p.id === preset.id
                              ? { ...p, command: event.target.value }
                              : p,
                          ),
                        )
                      }
                    />
                  </div>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`Remove ${preset.name} preset`}
                    disabled={draftPresets.length === 1}
                    onClick={() =>
                      setDraftPresets((items) =>
                        items.filter((p) => p.id !== preset.id),
                      )
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  setDraftPresets((items) => [
                    ...items,
                    { id: crypto.randomUUID(), name: "", command: "" },
                  ])
                }
              >
                <Plus size={14} />
                Add preset
              </button>
              <p className="form-note">
                Commands run with Bash in the selected directory. Tools must
                be installed on this machine. Existing terminals keep their
                original command.
              </p>
            </div>
          )}
          <div className="modal-actions">
            <button
              type="button"
              className="secondary"
              onClick={close}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              className={dialog === "delete" ? "danger" : "primary"}
              disabled={busy}
            >
              {busy
                ? "Working…"
                : dialog === "create"
                  ? "Create session"
                  : dialog === "delete"
                    ? "Stop terminals & delete"
                    : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
