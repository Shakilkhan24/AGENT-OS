import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  File,
  FilePlus2,
  Folder,
  FolderPlus,
  LockKeyhole,
  MoveRight,
  Pencil,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import type { FileEntry, FilePreview, SessionView } from "../shared/types";
import { Field, Modal } from "./components";
const join = (base: string, name: string) => (base ? `${base}/${name}` : name);
export function FilePanel({
  session,
  report,
}: {
  session: SessionView;
  report: (error: unknown) => void;
}) {
  const [directory, setDirectory] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [operationError, setOperationError] = useState("");
  const [modal, setModal] = useState<
    "file" | "directory" | "rename" | "move" | "delete"
  >();
  const [preview, setPreview] = useState<
    FilePreview & { path: string; original: string }
  >();
  const [discard, setDiscard] = useState(false);
  useEffect(() => {
    setOperationError("");
  }, [modal, preview?.path]);
  const reportOperation = (error: unknown) => {
    setOperationError(error instanceof Error ? error.message : String(error));
    report(error);
  };
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setError("");
    setSelected(undefined);
    window.minimal
      .files(session.id, { action: "list", path: directory })
      .then((result) => {
        if (!stale) setEntries(result);
      })
      .catch((error) => {
        if (!stale) {
          setEntries([]);
          setError(String(error.message));
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [session.id, directory, revision]);
  const refresh = () => setRevision((value) => value + 1);
  const open = async (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setDirectory(join(directory, entry.name));
      return;
    }
    if (entry.kind === "blocked") return;
    setBusy(true);
    try {
      const path = join(directory, entry.name);
      const result: FilePreview = await window.minimal.files(session.id, {
        action: "preview",
        path,
      });
      setPreview({ path, ...result, original: result.content });
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  };
  const operate = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget).get("path") || "");
    setBusy(true);
    try {
      const path = selected ? join(directory, selected.name) : "";
      if (modal === "file" || modal === "directory")
        await window.minimal.files(session.id, {
          action: "create",
          path: join(directory, value),
          kind: modal,
        });
      else if (modal === "delete")
        await window.minimal.files(session.id, { action: "delete", path });
      else
        await window.minimal.files(session.id, {
          action: "move",
          path,
          destination: modal === "rename" ? join(directory, value) : value,
        });
      setModal(undefined);
      refresh();
    } catch (error) {
      reportOperation(error);
    } finally {
      setBusy(false);
    }
  };
  const closePreview = () => {
    if (preview && preview.content !== preview.original) setDiscard(true);
    else setPreview(undefined);
  };
  return (
    <aside className="files-panel">
      <div className="panel-heading">
        <span>EXPLORER</span>
        <button
          className="icon-button"
          title="Refresh files"
          aria-label="Refresh files"
          onClick={refresh}
        >
          <RefreshCw size={14} />
        </button>
      </div>
      <div className="file-root">
        <Folder size={16} />
        <strong title={session.directory}>
          {session.directory.split("/").filter(Boolean).at(-1) || "/"}
        </strong>
        <span className="root-badge">ROOT</span>
      </div>
      <div className="file-toolbar">
        <button
          className="icon-button"
          title="New file"
          aria-label="New file"
          onClick={() => setModal("file")}
          disabled={!!error}
        >
          <FilePlus2 size={16} />
        </button>
        <button
          className="icon-button"
          title="New folder"
          aria-label="New folder"
          onClick={() => setModal("directory")}
          disabled={!!error}
        >
          <FolderPlus size={16} />
        </button>
        <span className="toolbar-divider" />
        <button
          className="icon-button"
          title="Rename selected"
          aria-label="Rename selected"
          disabled={!selected || selected.kind === "blocked"}
          onClick={() => setModal("rename")}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-button"
          title="Move selected"
          aria-label="Move selected"
          disabled={!selected || selected.kind === "blocked"}
          onClick={() => setModal("move")}
        >
          <MoveRight size={16} />
        </button>
        <button
          className="icon-button"
          title="Delete selected"
          aria-label="Delete selected"
          disabled={!selected || selected.kind === "blocked"}
          onClick={() => setModal("delete")}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <div className="breadcrumb">
        <button
          disabled={!directory}
          aria-label="Parent folder"
          onClick={() =>
            setDirectory(directory.split("/").slice(0, -1).join("/"))
          }
        >
          <ArrowLeft size={13} />
        </button>
        <span title={directory}>/{directory}</span>
      </div>
      <div className="file-list">
        {loading ? (
          <p className="panel-empty">Loading files…</p>
        ) : error ? (
          <p className="panel-error">{error}</p>
        ) : entries.length === 0 ? (
          <p className="panel-empty">
            This folder is empty.
            <br />
            Create a file to get started.
          </p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.name}
              className={`file-row ${selected?.name === entry.name ? "selected" : ""}`}
              disabled={entry.kind === "blocked"}
              title={
                entry.kind === "blocked"
                  ? "Links and special files are blocked"
                  : entry.name
              }
              onClick={() => setSelected(entry)}
              onDoubleClick={() => void open(entry)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void open(entry);
              }}
            >
              {entry.kind === "directory" ? (
                <Folder size={15} className="folder-icon" />
              ) : entry.kind === "blocked" ? (
                <LockKeyhole size={14} />
              ) : (
                <File size={14} />
              )}
              <span>{entry.name}</span>
              {entry.kind === "directory" && <ChevronRight size={12} />}
            </button>
          ))
        )}
      </div>
      {selected && selected.kind !== "blocked" && (
        <button
          className="open-file"
          disabled={busy}
          onClick={() => void open(selected)}
        >
          {selected.kind === "directory" ? "Open folder" : "Open file"}
          <ChevronRight size={14} />
        </button>
      )}
      <div className="file-footer">
        <LockKeyhole size={13} />
        <span>Scoped to this session</span>
        <span>{entries.length} items</span>
      </div>
      {modal && (
        <Modal
          title={
            modal === "file"
              ? "New file"
              : modal === "directory"
                ? "New folder"
                : modal === "delete"
                  ? "Delete permanently?"
                  : modal === "move"
                    ? "Move item"
                    : "Rename item"
          }
          subtitle={
            modal === "delete"
              ? `${selected?.name} and its contents will be permanently removed.`
              : `Within ${session.directory}`
          }
          close={() => setModal(undefined)}
          busy={busy}
          error={operationError}
        >
          <form onSubmit={operate}>
            {modal !== "delete" && (
              <Field
                label={
                  modal === "move"
                    ? "Destination path from session root"
                    : "Name"
                }
                hint={
                  modal === "move"
                    ? "Include the new filename, for example src/example.ts. The parent folder must exist."
                    : undefined
                }
              >
                <input
                  name="path"
                  autoFocus
                  required
                  maxLength={4096}
                  defaultValue={
                    modal === "rename"
                      ? selected?.name
                      : modal === "move"
                        ? join(directory, selected?.name || "")
                        : ""
                  }
                />
              </Field>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                onClick={() => setModal(undefined)}
                disabled={busy}
              >
                Cancel
              </button>
              <button
                className={modal === "delete" ? "danger" : "primary"}
                disabled={busy}
              >
                {busy
                  ? "Working…"
                  : modal === "delete"
                    ? "Delete permanently"
                    : "Save"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {preview && (
        <Modal
          title={preview.path.split("/").at(-1)!}
          subtitle={`/${preview.path}`}
          close={closePreview}
          busy={busy}
          error={operationError}
        >
          {preview.kind === "text" ? (
            <textarea
              className="file-editor"
              aria-label="File contents"
              spellCheck={false}
              value={preview.content}
              onChange={(event) =>
                setPreview({ ...preview, content: event.target.value })
              }
            />
          ) : preview.kind === "image" ? (
            <div className="image-preview">
              <img alt={preview.path} src={preview.content} />
            </div>
          ) : (
            <div>
              <p className="form-note">
                Byte preview · first{" "}
                {Math.min(preview.size, 1024).toLocaleString()} of{" "}
                {preview.size.toLocaleString()} bytes. This view is read-only.
              </p>
              <pre className="binary-preview" aria-label="File bytes">
                {preview.content}
              </pre>
            </div>
          )}
          <div className="modal-actions">
            <span className="muted">
              {preview.kind === "text"
                ? preview.content === preview.original
                  ? "Saved · UTF-8"
                  : "Unsaved changes"
                : `${preview.size.toLocaleString()} bytes`}
            </span>
            <button className="secondary" onClick={closePreview}>
              Close
            </button>
            {preview.kind === "text" && (
              <button
                className="primary"
                disabled={busy || preview.content === preview.original}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await window.minimal.files(session.id, {
                      action: "write",
                      path: preview.path,
                      content: preview.content,
                    });
                    setPreview({ ...preview, original: preview.content });
                    setOperationError("");
                    refresh();
                  } catch (error) {
                    reportOperation(error);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Save size={14} />
                {busy ? "Saving…" : "Save file"}
              </button>
            )}
          </div>
        </Modal>
      )}
      {discard && (
        <Modal
          title="Discard unsaved changes?"
          subtitle="Your edits to this file have not been saved."
          close={() => setDiscard(false)}
        >
          <div className="modal-actions">
            <button className="secondary" onClick={() => setDiscard(false)}>
              Keep editing
            </button>
            <button
              className="danger"
              onClick={() => {
                setDiscard(false);
                setPreview(undefined);
              }}
            >
              Discard changes
            </button>
          </div>
        </Modal>
      )}
    </aside>
  );
}
