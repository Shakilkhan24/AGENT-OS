import { useState } from "react";
import { ArrowUpRight, ChevronRight, CircleHelp, Command, Folder, Layers2, Plus, Search, Settings2, TerminalSquare } from "lucide-react";
import type { Snapshot } from "../shared/types";
import type { Dialog } from "./WorkspaceDialog";

export function SessionSidebar({ snapshot, selectedId, ready, version, selectSession, openDialog }: {
  snapshot: Pick<Snapshot, "sessions" | "engineError">;
  selectedId?: string;
  ready: boolean;
  version: string;
  selectSession(id: string): void;
  openDialog(dialog: Dialog): void;
}) {
  const [query, setQuery] = useState("");
  const filtered = snapshot.sessions.filter(session =>
    `${session.name} ${session.directory}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-icon">
          <Command size={20} />
        </span>
        <span>
          MINIMAL<span className="version">{version ? `v${version}` : ""}</span>
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
            className={`session-card ${selectedId === item.id ? "active" : ""}`}
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
  );
}
