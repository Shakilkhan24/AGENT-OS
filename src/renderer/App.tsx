import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleHelp,
  Command,
  Folder,
  FolderOpen,
  Layers2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  Pencil,
  Plus,
  Search,
  Settings2,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type {
  LaunchRequest,
  Preset,
  Snapshot,
  TerminalView,
} from "../shared/types";
import { FilePanel } from "./FilePanel";
import { TerminalTabs } from "./TerminalTabs";
import { LaunchDialog } from "./LaunchDialog";
import { useWorkspace } from "./useWorkspace";
const Terminal = lazy(() =>
  import("./Terminal").then((module) => ({ default: module.Terminal })),
);
import { Field, Modal } from "./components";
type Dialog =
  | "create"
  | "rename"
  | "delete"
  | "launch"
  | "terminal-name"
  | "presets"
  | "help";
export function App() {
  const [sessionId, setSessionId] = useState(
    localStorage.getItem("minimal.session") || "",
  );
  const [terminalIds, setTerminalIds] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("minimal.terminals") || "{}",
      );
      return saved && typeof saved === "object" && !Array.isArray(saved)
        ? Object.fromEntries(
            Object.entries(saved).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            ),
          )
        : {};
    } catch {
      return {};
    }
  });
  const [explorerVisible, setExplorerVisible] = useState(
    localStorage.getItem("minimal.explorer") !== "hidden",
  );
  const [launchInitial, setLaunchInitial] = useState<LaunchRequest>({
    command: "",
  });
  const lastLaunch = useRef<Record<string, LaunchRequest>>({});
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const closingRef = useRef(new Set<string>());
  const mutationLock = useRef(false);
  useEffect(() => {
    localStorage.setItem("minimal.terminals", JSON.stringify(terminalIds));
  }, [terminalIds]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>();
  const [directory, setDirectory] = useState("");
  const [draftPresets, setDraftPresets] = useState<Preset[]>([]);
  const report = useCallback(
    (error: unknown) =>
      setError(
        String(error instanceof Error ? error.message : error).replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      ),
    [],
  );
  const { snapshot, ready, accept } = useWorkspace(report);
  const session =
    snapshot.sessions.find((s) => s.id === sessionId) || snapshot.sessions[0];
  const terminal =
    session?.terminals.find((t) => t.id === terminalIds[session.id]) ||
    session?.terminals[0];
  const running = snapshot.sessions
    .flatMap((s) => s.terminals)
    .filter((t) => t.status === "running").length;
  const selectSession = (id: string) => {
    setSessionId(id);
    localStorage.setItem("minimal.session", id);
  };
  const openDialog = (value: Dialog) => {
    setError("");
    if (value === "create") setDirectory("");
    if (value === "launch" && session)
      setLaunchInitial(lastLaunch.current[session.id] || { command: "" });
    if (value === "presets") setDraftPresets(structuredClone(snapshot.presets));
    setDialog(value);
  };
  const mutate = async (operation: () => Promise<Snapshot>) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await operation();
      accept(result);
      setDialog(undefined);
      return result;
    } catch (error) {
      report(error);
      return undefined;
    } finally {
      mutationLock.current = false;
      setBusy(false);
    }
  };
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const name = String(values.get("name") || "");
    if (dialog === "create") {
      const result = await mutate(() =>
        window.minimal.createSession(name, directory),
      );
      if (result) selectSession(result.sessions.at(-1)!.id);
    } else if (dialog === "rename")
      await mutate(() => window.minimal.renameSession(session!.id, name));
    else if (dialog === "delete")
      await mutate(() => window.minimal.deleteSession(session!.id));
    else if (dialog === "terminal-name")
      await mutate(() =>
        window.minimal.renameTerminal(session!.id, terminal!.id, name),
      );
    else if (dialog === "presets")
      await mutate(() => window.minimal.savePresets(draftPresets));
  };
  const launch = async (request: LaunchRequest) => {
    if (!session) return;
    const targetSession = session.id;
    const result = await mutate(() =>
      window.minimal.launchTerminals(targetSession, request),
    );
    if (result && "terminalIds" in result) {
      const launched = result as Awaited<
        ReturnType<typeof window.minimal.launchTerminals>
      >;
      lastLaunch.current[targetSession] = {
        command: request.command,
        cwd: request.cwd,
        label: request.label,
      };
      if (launched.terminalIds.length)
        setTerminalIds((ids) => ({
          ...ids,
          [targetSession]: launched.terminalIds.at(-1)!,
        }));
      if (launched.launchErrors.length)
        report(
          `${launched.launchErrors.length} terminal(s) could not start. Select their tabs for details, then use Edit & run to retry.`,
        );
    }
  };
  const editAndRun = (item: TerminalView) => {
    if (!session) return;
    const candidate = item.currentDirectory || item.cwd;
    const cwd =
      candidate === session.directory
        ? ""
        : candidate.startsWith(session.directory + "/")
          ? candidate.slice(session.directory.length + 1)
          : "";
    setLaunchInitial({ command: item.command, cwd });
    setError("");
    setDialog("launch");
  };
  const closeTerminal = async (targetSession: string, terminalId: string) => {
    if (closingRef.current.has(terminalId)) return;
    closingRef.current.add(terminalId);
    setClosing(new Set(closingRef.current));
    const oldSession = snapshot.sessions.find((s) => s.id === targetSession);
    try {
      const result = await window.minimal.deleteTerminal(
        targetSession,
        terminalId,
      );
      accept(result);
      const remaining =
        result.sessions.find((s) => s.id === targetSession)?.terminals || [];
      setTerminalIds((ids) => {
        if ((ids[targetSession] || oldSession?.terminals[0]?.id) !== terminalId)
          return ids;
        const previous = oldSession?.terminals || [];
        const index = previous.findIndex((t) => t.id === terminalId);
        const next =
          [
            ...previous.slice(index + 1),
            ...previous.slice(0, index).reverse(),
          ].find((t) => remaining.some((r) => r.id === t.id)) || remaining[0];
        return { ...ids, [targetSession]: next?.id || "" };
      });
    } catch (error) {
      report(error);
    } finally {
      closingRef.current.delete(terminalId);
      setClosing(new Set(closingRef.current));
    }
  };
  const filtered = snapshot.sessions.filter((s) =>
    `${s.name} ${s.directory}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-icon">
            <Command size={20} />
          </span>
          <span>
            MINIMAL<span className="version">v1</span>
          </span>
        </div>
        <div className="workspace-label">
          YOUR WORKSPACE
          <span className="dot live" />
        </div>
        <div className="session-section">
          <span>Sessions</span>
          <span className="count">{snapshot.sessions.length}</span>
          <button
            className="icon-button"
            aria-label="Create session"
            onClick={() => openDialog("create")}
          >
            <Plus size={16} />
          </button>
        </div>
        <label className="search-box">
          <Search size={14} />
          <input
            aria-label="Search sessions"
            placeholder="Find a session…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌕</kbd>
        </label>
        <nav className="session-list" aria-label="Sessions">
          {filtered.map((item) => (
            <button
              key={item.id}
              className={`session-card ${session?.id === item.id ? "active" : ""}`}
              onClick={() => selectSession(item.id)}
            >
              <span className="session-card-title">
                <Folder size={16} />
                <strong>{item.name}</strong>
                <span
                  className={`dot ${item.terminals.some((t) => t.status === "running") ? "live" : ""}`}
                />
              </span>
              <span className="session-directory" title={item.directory}>
                {item.directory}
              </span>
              <span className="session-meta">
                <TerminalSquare size={12} />
                {item.terminals.length} terminal
                {item.terminals.length !== 1 ? "s" : ""}
                <span>
                  {snapshot.engineError
                    ? "Status unavailable"
                    : `${item.terminals.filter((t) => t.status === "running").length} running`}
                </span>
              </span>
            </button>
          ))}
          {ready && filtered.length === 0 && (
            <p className="sidebar-empty">
              {query ? "No matching sessions." : "A fresh space for your work."}
            </p>
          )}
        </nav>
        <button className="new-session" onClick={() => openDialog("create")}>
          <Plus size={16} />
          New session
        </button>
        <div className="sidebar-bottom">
          <div className="persistence-note">
            <span className="persistence-icon">
              <Layers2 size={18} />
            </span>
            <div>
              <strong>Your work stays alive.</strong>
              <p>Close the window. Pick up later.</p>
            </div>
          </div>
          <button className="nav-button" onClick={() => openDialog("presets")}>
            <Settings2 size={16} />
            Launch presets
            <ChevronRight size={14} />
          </button>
          <button className="nav-button" onClick={() => openDialog("help")}>
            <CircleHelp size={16} />
            How it works
            <ArrowUpRight size={14} />
          </button>
        </div>
        <div className="sidebar-status">
          <span className={`dot ${snapshot.engineError ? "" : "live"}`} />
          {snapshot.engineError ? "Connection issue" : "Local workspace"}
          <span>FOUNDATION</span>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="topbar-crumb">
            <Layers2 size={15} />
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{session?.name || "Overview"}</strong>
          </div>
          <span className="running-pill">
            <span className={`dot ${snapshot.engineError ? "" : "live"}`} />
            {snapshot.engineError ? "Status unavailable" : `${running} running`}
          </span>
        </header>
        {error && (
          <div className="error-toast" role="alert">
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Dismiss error"
              onClick={() => setError("")}
            >
              <X size={16} />
            </button>
          </div>
        )}
        {snapshot.engineError && (
          <div className="engine-error" role="alert">
            Could not reconcile running work: {snapshot.engineError}. Retrying
            automatically.
          </div>
        )}
        {session ? (
          <>
            <section className="session-header">
              <div>
                <div className="eyebrow">
                  SESSION /{" "}
                  {String(snapshot.sessions.indexOf(session) + 1).padStart(
                    2,
                    "0",
                  )}
                </div>
                <div className="session-title">
                  <h1>{session.name}</h1>
                  <button
                    className="icon-button"
                    aria-label="Rename session"
                    onClick={() => openDialog("rename")}
                  >
                    <Pencil size={15} />
                  </button>
                </div>
                <div className="session-path">
                  <FolderOpen size={14} />
                  <span title={session.directory}>{session.directory}</span>
                </div>
              </div>
              <div className="session-actions">
                <button
                  className="icon-button"
                  aria-label={
                    explorerVisible ? "Hide explorer" : "Show explorer"
                  }
                  title={explorerVisible ? "Hide explorer" : "Show explorer"}
                  onClick={() =>
                    setExplorerVisible((value) => {
                      localStorage.setItem(
                        "minimal.explorer",
                        value ? "hidden" : "visible",
                      );
                      return !value;
                    })
                  }
                >
                  {explorerVisible ? (
                    <PanelRightClose size={18} />
                  ) : (
                    <PanelRightOpen size={18} />
                  )}
                </button>
                <button
                  className="icon-button danger-hover"
                  aria-label="Delete session"
                  title="Delete session"
                  onClick={() => openDialog("delete")}
                >
                  <Trash2 size={17} />
                </button>
                <button
                  className="primary"
                  onClick={() => openDialog("launch")}
                >
                  <Plus size={16} />
                  Launch terminals
                </button>
              </div>
            </section>
            <div className="work-area">
              <section className="terminal-panel">
                <div className="panel-heading">
                  <span>
                    <TerminalSquare size={14} />
                    TERMINALS <b>{session.terminals.length}</b>
                  </span>
                  <span className="panel-label">
                    Independent. Persistent. Yours.
                  </span>
                </div>
                <TerminalTabs
                  terminals={session.terminals}
                  selected={terminal?.id}
                  closing={closing}
                  select={(id) =>
                    setTerminalIds((ids) => ({ ...ids, [session.id]: id }))
                  }
                  close={(id) => void closeTerminal(session.id, id)}
                  add={() => openDialog("launch")}
                />
                {terminal ? (
                  <>
                    <div className="terminal-info">
                      <span className="process-label">
                        {terminal.process ||
                          (terminal.status === "missing" ? "missing" : "bash")}
                      </span>
                      <span
                        className="terminal-cwd"
                        title={terminal.currentDirectory || terminal.cwd}
                      >
                        {terminal.currentDirectory || terminal.cwd}
                      </span>
                      <button
                        className="icon-button"
                        title="Rename terminal"
                        aria-label="Rename terminal"
                        onClick={() => openDialog("terminal-name")}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        className="terminal-action"
                        title="Edit the command and launch another terminal"
                        onClick={() => editAndRun(terminal)}
                      >
                        <RotateCw size={13} />
                        Edit &amp; run
                      </button>
                      <button
                        className="icon-button danger-hover"
                        title={`Stop and close ${terminal.label}`}
                        aria-label="Remove terminal"
                        disabled={closing.has(terminal.id) || terminal.deleting}
                        onClick={() =>
                          void closeTerminal(session.id, terminal.id)
                        }
                      >
                        <X size={15} />
                      </button>
                    </div>
                    <Suspense
                      fallback={
                        <p className="panel-empty">Loading terminal…</p>
                      }
                    >
                      <Terminal
                        key={terminal.id}
                        terminal={terminal}
                        report={report}
                      />
                    </Suspense>
                  </>
                ) : (
                  <div className="empty-terminals">
                    <div className="empty-icon">
                      <TerminalSquare size={31} />
                    </div>
                    <span className="eyebrow">ROOM TO BUILD</span>
                    <h2>Start something here.</h2>
                    <p>
                      A shell, your editor, a coding agent.
                      <br />
                      One terminal or a whole team of them.
                    </p>
                    <button
                      className="primary"
                      onClick={() => openDialog("launch")}
                    >
                      <Plus size={16} />
                      Launch your first terminal
                    </button>
                    <span className="empty-footnote">
                      <Check size={13} />
                      Keeps running when you close the app
                    </span>
                  </div>
                )}
              </section>
              {explorerVisible && (
                <FilePanel key={session.id} session={session} report={report} />
              )}
            </div>
          </>
        ) : (
          <section className="welcome">
            <div className="welcome-mark">
              <Command size={44} />
            </div>
            <div className="eyebrow">LESS SETUP. MORE MAKING.</div>
            <h1>Your work, still running.</h1>
            <p>
              Give each project a home. Keep its terminals and files together.
              <br />
              Come back exactly where you left off.
            </p>
            <button
              className="primary"
              onClick={() => openDialog("create")}
              disabled={!ready}
            >
              <Plus size={17} />
              {ready
                ? "Create your first session"
                : "Connecting to your workspace…"}
            </button>
            <div className="welcome-features">
              <span>
                <Folder size={17} />
                One folder. One session.
              </span>
              <span>
                <Zap size={17} />
                Launch in a click.
              </span>
              <span>
                <Layers2 size={17} />
                Built to stay running.
              </span>
            </div>
          </section>
        )}
        <footer className="app-footer">
          <span>
            LOCAL FIRST<span className="footer-separator">/</span>BUILT FOR
            FOCUS
          </span>
          <span>
            {session
              ? `${session.terminals.length} terminals in this session`
              : "A quieter way to manage your work"}
            <span className="footer-separator">·</span>MINIMAL 1.1
          </span>
        </footer>
      </main>
      {dialog === "launch" && (
        <LaunchDialog
          presets={snapshot.presets}
          initial={launchInitial}
          busy={busy}
          error={error}
          close={() => setDialog(undefined)}
          launch={launch}
        />
      )}
      {dialog && dialog !== "launch" && (
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
          close={() => setDialog(undefined)}
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
                Ctrl+Shift+V copy and paste; right-click copies a selection or
                pastes.
              </p>
              <button className="primary" onClick={() => setDialog(undefined)}>
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
                        ? session?.name
                        : dialog === "terminal-name"
                          ? terminal?.label
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
                  onClick={() => setDialog(undefined)}
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
      )}
    </div>
  );
}
