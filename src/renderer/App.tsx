import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Command,
  Folder,
  FolderOpen,
  Layers2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
  Pencil,
  Plus,
  TerminalSquare,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import type { LaunchRequest, Preset, Snapshot, TerminalView } from "../shared/types";
import { FilePanel } from "./FilePanel";
import { TerminalTabs } from "./TerminalTabs";
import { LaunchDialog } from "./LaunchDialog";
import { useWorkspace } from "./useWorkspace";
const Terminal = lazy(() =>
  import("./Terminal").then((module) => ({ default: module.Terminal })),
);
import { SessionSidebar } from "./SessionSidebar";
import { WorkspaceDialog, type Dialog } from "./WorkspaceDialog";
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
  const [error, setError] = useState("");
  const [version, setVersion] = useState("");
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
  useEffect(() => {
    let active = true;
    void window.minimal.getAppInfo().then(info => { if (active) setVersion(info.appVersion); }).catch(report);
    return () => { active = false; };
  }, [report]);
  const { snapshot, ready, accept } = useWorkspace(report);
  // Surface a recovery notice (e.g. malformed state.json) from the main
  // process through the same toast channel IPC errors use.
  useEffect(() => {
    return window.minimal.onStartupRecovered((message) => report(message));
  }, [report]);
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
      if (launched.terminalIds.length || launched.launchErrors.length) {
        // Prefer a failed terminal so the user lands on the surface that
        // explains the failure ("Could not start this terminal" + reason +
        // Edit & run hint). Otherwise jump to the newly-launched terminal.
        const focusId =
          launched.launchErrors[0]?.terminalId ?? launched.terminalIds.at(-1)!;
        setTerminalIds((ids) => ({
          ...ids,
          [targetSession]: focusId,
        }));
      }
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
  return (
    <div className="app-shell">
      <SessionSidebar snapshot={snapshot} selectedId={session?.id} ready={ready} version={version}
        selectSession={selectSession} openDialog={openDialog} />
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
            <span className="footer-separator">·</span>MINIMAL {version}
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
        <WorkspaceDialog dialog={dialog} busy={busy} error={error} close={() => setDialog(undefined)}
          submit={submit} sessionName={session?.name} terminalLabel={terminal?.label}
          directory={directory} setDirectory={setDirectory} draftPresets={draftPresets}
          setDraftPresets={setDraftPresets} report={report} />
      )}
    </div>
  );
}
