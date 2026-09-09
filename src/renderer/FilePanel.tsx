import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  FilePlus2,
  Folder,
  FolderPlus,
  LockKeyhole,
  MoveRight,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import type { FileEntry, SessionView } from "../shared/types";
import { Field, Modal } from "./components";
import type { DraftSummary } from "../shared/drafts";
import { FileEditor, type OpenFile } from "./FileEditor";
import { VirtualFileList } from "./VirtualFileList";
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
  const [opened, setOpened] = useState<OpenFile>();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  const [cursor, setCursor] = useState<string>();
  const [truncated, setTruncated] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const generation = useRef(0);
  const loadDrafts = () => { void window.minimal.listDrafts().then(items => setDrafts(items.filter(item => item.sessionId === session.id))).catch(report); };
  useEffect(loadDrafts, [session.id, opened]);
  useEffect(() => {
    setOperationError("");
  }, [modal, opened?.path]);
  const reportOperation = (error: unknown) => {
    setOperationError(error instanceof Error ? error.message : String(error));
    report(error);
  };
  useEffect(() => {
    let stale = false;
    generation.current++; setCursor(undefined); setLoadingMore(false);
    setLoading(true);
    setError("");
    setSelected(undefined);
    window.minimal
      .files(session.id, { action: "list-page", path: directory })
      .then((result) => {
        if (!stale) { setEntries(result.entries); setCursor(result.cursor); setTruncated(result.truncated); }
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
  const loadMore = async () => {
    if (!cursor || loadingMore) return;
    const current = generation.current; setLoadingMore(true);
    try {
      const page = await window.minimal.files(session.id, { action: "list-page", path: directory, cursor });
      if (current === generation.current) {
        setEntries(items => [...new Map([...items, ...page.entries].map(item => [item.name, item])).values()]);
        setCursor(page.cursor); setTruncated(page.truncated);
      }
    } catch (error) { if (current === generation.current) report(error); }
    finally { if (current === generation.current) setLoadingMore(false); }
  };
  const edit = async (path: string, draftId?: string) => {
    const result = await window.minimal.files(session.id, { action: "preview", path });
    const id = draftId ?? drafts.find(item => item.path === path)?.id;
    const draft = id ? await window.minimal.readDraft(id) : undefined;
    setOpened({ path, preview: result, draft }); setShowDrafts(false);
  };
  const open = async (entry: FileEntry) => {
    if (entry.kind === "directory") {
      setDirectory(join(directory, entry.name));
      return;
    }
    if (entry.kind === "blocked") return;
    setBusy(true);
    try {
      const path = join(directory, entry.name);
      await edit(path);
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
      {loading ? <p className="panel-empty">Loading files…</p> : error ? <p className="panel-error">{error}</p>
        : entries.length === 0 && !cursor ? <p className="panel-empty">This folder is empty.<br />Create a file to get started.</p>
        : <VirtualFileList key={directory + revision} entries={entries} selected={selected} select={setSelected} open={entry => void open(entry)} more={cursor ? () => void loadMore() : undefined} loading={loadingMore} />}
      {truncated && <p className="form-note">Listing stopped at 20,000 entries. Open a subfolder to narrow the view.</p>}
      {drafts.length > 0 && <button className="open-file" onClick={() => setShowDrafts(true)}>{drafts.length} recovery {drafts.length === 1 ? "draft" : "drafts"}<ChevronRight size={14} /></button>}
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
      {opened && <FileEditor key={opened.path} sessionId={session.id} file={opened} close={() => setOpened(undefined)} report={report} saved={() => { refresh(); loadDrafts(); }} />}
      {showDrafts && <Modal title="Recovery drafts" subtitle="Edits preserved for this session." close={() => setShowDrafts(false)} busy={busy} error={operationError}>
        {drafts.map(draft => <div className="modal-actions" key={draft.id}>
          <span className="muted" title={draft.path}>{draft.path}</span>
          <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await edit(draft.path, draft.id); } catch (error) { reportOperation(error); } finally { setBusy(false); } }}>Restore</button>
          <button className="danger" disabled={busy} onClick={async () => { setBusy(true); try { await window.minimal.removeDraft(draft.id); loadDrafts(); } catch (error) { reportOperation(error); } finally { setBusy(false); } }}>Discard</button>
        </div>)}
      </Modal>}
    </aside>
  );
}
