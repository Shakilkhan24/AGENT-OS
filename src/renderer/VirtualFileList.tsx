import { useEffect, useRef, useState } from "react";
import { ChevronRight, File, Folder, LockKeyhole } from "lucide-react";
import type { FileEntry } from "../shared/files";
const ROW = 32, OVERSCAN = 6;
export function VirtualFileList({ entries, selected, select, open, more, loading }: {
  entries: FileEntry[]; selected?: FileEntry; select(entry: FileEntry): void; open(entry: FileEntry): void;
  more?: () => void; loading: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ top: 0, height: 320 });
  useEffect(() => {
    const element = ref.current!;
    const observer = new ResizeObserver(() => setViewport(value => ({ ...value, height: element.clientHeight })));
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const start = Math.max(0, Math.floor(viewport.top / ROW) - OVERSCAN);
  const end = Math.min(entries.length, Math.ceil((viewport.top + viewport.height) / ROW) + OVERSCAN);
  return <div className="file-list" ref={ref} role="listbox" aria-label="Files" tabIndex={0}
    onScroll={event => {
      const element = event.currentTarget;
      setViewport({ top: element.scrollTop, height: element.clientHeight });
      if (more && !loading && element.scrollTop + element.clientHeight >= element.scrollHeight - 128) more();
    }} onKeyDown={event => {
      const index = entries.findIndex(entry => entry.name === selected?.name);
      let next = index;
      if (event.key === "ArrowDown") next = Math.min(entries.length - 1, index + 1);
      else if (event.key === "ArrowUp") next = Math.max(0, index - 1);
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = entries.length - 1;
      else if (event.key === "Enter" && selected) { event.preventDefault(); open(selected); return; }
      else return;
      event.preventDefault();
      if (!entries[next]) return;
      select(entries[next]);
      const element = ref.current!; element.focus();
      if (next * ROW < element.scrollTop) element.scrollTop = next * ROW;
      if ((next + 1) * ROW > element.scrollTop + element.clientHeight) element.scrollTop = (next + 1) * ROW - element.clientHeight;
    }}>
    <div style={{ height: entries.length * ROW, position: "relative" }}>
      {entries.slice(start, end).map((entry, offset) => <button key={entry.name} role="option" aria-selected={selected?.name === entry.name}
        className={`file-row ${selected?.name === entry.name ? "selected" : ""}`} tabIndex={-1}
        style={{ position: "absolute", top: (start + offset) * ROW, height: ROW, width: "100%" }}
        aria-disabled={entry.kind === "blocked"} title={entry.kind === "blocked" ? "Links and special files are blocked" : entry.name}
        onClick={() => select(entry)} onDoubleClick={() => open(entry)}>
        {entry.kind === "directory" ? <Folder size={15} className="folder-icon" /> : entry.kind === "blocked" ? <LockKeyhole size={14} /> : <File size={14} />}
        <span>{entry.name}</span>{entry.kind === "directory" && <ChevronRight size={12} />}
      </button>)}
    </div>
    {more && <button className="open-file" disabled={loading} onClick={more}>{loading ? "Loading…" : "Load more files"}</button>}
  </div>;
}
