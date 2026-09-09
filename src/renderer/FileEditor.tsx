import { useEffect, useRef, useState } from "react";
import { Save } from "lucide-react";
import type { Draft } from "../shared/drafts";
import type { FilePreview } from "../shared/files";
import { Modal } from "./components";
import { DraftMirror } from "./draft-mirror";

export interface OpenFile { path: string; preview: FilePreview; draft?: Draft }
export function FileEditor({ sessionId, file, close, report, saved }: {
  sessionId: string; file: OpenFile; close(): void; report(error: unknown): void; saved(): void;
}) {
  const [content, setContent] = useState(file.draft?.content ?? file.preview.content);
  const [original, setOriginal] = useState(file.preview.content);
  const [hash, setHash] = useState(file.draft?.baseHash ?? file.preview.hash);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [discard, setDiscard] = useState(false), [conflict, setConflict] = useState<FilePreview>();
  const reporter = useRef(report); reporter.current = report;
  const mirror = useRef<DraftMirror | undefined>(undefined);
  if (!mirror.current) {
    mirror.current = new DraftMirror(window.minimal.saveDraft, window.minimal.removeDraft, error => reporter.current(error));
    if (file.draft) mirror.current.restore(file.draft.id);
  }
  const kind = file.draft ? "text" : file.preview.kind;
  const dirty = kind === "text" && content !== original;
  useEffect(() => {
    if (dirty && hash) mirror.current!.schedule({ sessionId, path: file.path, content, baseHash: hash });
    else if (kind === "text") void mirror.current!.discard().catch(error => reporter.current(error));
  }, [content, dirty, hash, sessionId, file.path, kind]);
  useEffect(() => {
    let allowClose = false;
    void window.minimal.getSettings().then(settings => mirror.current!.setDelay(settings.draftIntervalMs)).catch(error => reporter.current(error));
    const flush = (event: BeforeUnloadEvent) => {
      if (allowClose) return;
      event.preventDefault(); event.returnValue = false;
      void mirror.current!.flush().then(() => { allowClose = true; window.close(); }).catch(error => reporter.current(error));
    };
    window.addEventListener("beforeunload", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      void mirror.current!.flush().catch(error => reporter.current(error));
    };
  }, []);
  const failure = (error: unknown) => { setError(error instanceof Error ? error.message : String(error)); report(error); };
  const save = async (expectedHash: string) => {
    setBusy(true);
    try {
      await mirror.current!.flush();
      const result = await window.minimal.files(sessionId, { action: "write", path: file.path, content, expectedHash });
      if (!result.saved) { setConflict(result.current); return; }
      await mirror.current!.discard();
      setOriginal(content); setHash(result.hash); setConflict(undefined); setError(""); saved();
    } catch (error) { failure(error); }
    finally { setBusy(false); }
  };
  const requestClose = () => { if (dirty) setDiscard(true); else close(); };
  return <>
    <Modal title={file.path.split("/").at(-1)!} subtitle={`/${file.path}`} close={requestClose} busy={busy} error={error}>
      {file.draft && <p className="form-note">Recovered draft · {new Date(file.draft.updatedAt).toLocaleString()}</p>}
      {kind === "text" ? <textarea className="file-editor" aria-label="File contents" spellCheck={false} value={content} disabled={busy} onChange={event => setContent(event.target.value)} />
        : kind === "image" ? <div className="image-preview"><img alt={file.path} src={content} /></div>
        : <div><p className="form-note">Byte preview · first {Math.min(file.preview.size, 1024).toLocaleString()} of {file.preview.size.toLocaleString()} bytes.</p><pre className="binary-preview" aria-label="File bytes">{content}</pre></div>}
      <div className="modal-actions">
        <span className="muted">{kind === "text" ? dirty ? "Unsaved · recovery draft mirrors automatically" : "Saved · UTF-8" : `${file.preview.size.toLocaleString()} bytes`}</span>
        <button className="secondary" onClick={requestClose} disabled={busy}>Close</button>
        {kind === "text" && <button className="primary" disabled={busy || !dirty || !hash} onClick={() => void save(hash!)}><Save size={14} />{busy ? "Saving…" : "Save file"}</button>}
      </div>
    </Modal>
    {conflict && <Modal title="File changed outside MINIMAL" subtitle="Your edits are preserved. Review the disk version before replacing it." close={() => setConflict(undefined)} busy={busy} error={error}>
      <pre className="binary-preview" aria-label="Current disk contents">{conflict.kind === "text" ? conflict.content : "The disk version is no longer an editable text file."}</pre>
      <div className="modal-actions"><button className="secondary" onClick={() => setConflict(undefined)}>Keep editing</button><button className="danger" disabled={busy || !conflict.hash} onClick={() => void save(conflict.hash!)}>Replace reviewed version</button></div>
    </Modal>}
    {discard && <Modal title="Discard unsaved changes?" subtitle="Keep a recovery draft or discard these edits." close={() => setDiscard(false)} busy={busy} error={error}>
      <div className="modal-actions">
        <button className="secondary" onClick={() => setDiscard(false)}>Keep editing</button>
        <button className="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await mirror.current!.flush(); close(); } catch (error) { failure(error); } finally { setBusy(false); } }}>Keep draft and close</button>
        <button className="danger" disabled={busy} onClick={async () => { setBusy(true); try { await mirror.current!.discard(); close(); } catch (error) { failure(error); } finally { setBusy(false); } }}>Discard changes</button>
      </div>
    </Modal>}
  </>;
}
