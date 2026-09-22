/**
 * M3c.3 — persistent attention inbox panel.
 *
 * Slide-in left panel anchored to the left edge of the window, overlaying
 * the existing sidebar. Driven by `snapshot.managed.openAttention`. The
 * panel groups items by `(kind, issueIdentity)`; multiple revisions of
 * the same issue collapse into one card with a `+N older` disclosure.
 *
 * The buttons call `window.minimal.transitionAttention` (mark seen /
 * dismiss / resolve), `window.minimal.snoozeAttention` (snooze 1h), and
 * the parent passes `onChanged()` to refresh the projection after a
 * mutation. "Mark all as seen" is a footer loop best-effort: one
 * failure doesn't stop the rest.
 *
 * No `window.focus()` is called on any IPC path — background work
 * never steals focus (M3c.3 D-8).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Bell, Check, Clock, Eye, X } from "lucide-react";
import type { AttentionItemView } from "../shared/managed-view";
import "./AttentionInbox.module.css";

interface AttentionInboxProps {
  /** The open slice from the managed projection; absent when unavailable. */
  items: AttentionItemView[];
  /** Refresh the projection after a successful IPC mutation. */
  onChanged: () => void;
  /** Close the panel (parent owns visibility). */
  onClose: () => void;
}

interface Group {
  key: string;
  kind: AttentionItemView["kind"];
  issueIdentity: string;
  rows: AttentionItemView[];
  /** Latest `updatedAt` for sort stability. */
  latest: number;
}

function group(items: AttentionItemView[]): Group[] {
  const map = new Map<string, AttentionItemView[]>();
  for (const item of items) {
    const key = `${item.kind}:${item.issueIdentity}`;
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, rows]) => {
    const [kind, issueIdentity] = key.split(/:(.+)/) as [AttentionItemView["kind"], string];
    const latest = Math.max(...rows.map(row => Date.parse(row.updatedAt)));
    rows.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return { key, kind, issueIdentity, rows, latest };
  }).sort((left, right) => right.latest - left.latest);
}

function safeParse(json: string): string {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object") return json;
    return JSON.stringify(parsed, null, 2);
  } catch {
    return json;
  }
}

function snoozeOneHour(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

export function AttentionInbox({ items, onChanged, onClose }: AttentionInboxProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const groups = useMemo(() => group(items), [items]);

  // Escape key closes the panel — keyboard parity with the existing
  // M3c.1 close affordances.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const transition = useCallback(async (id: string, to: "seen" | "snoozed" | "dismissed" | "resolved") => {
    setError(null);
    setBusy(true);
    try {
      await window.minimal.transitionAttention(id, to);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const snooze = useCallback(async (id: string) => {
    setError(null);
    setBusy(true);
    try {
      await window.minimal.snoozeAttention(id, snoozeOneHour());
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [onChanged]);

  const markAllSeen = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      for (const item of items) {
        if (item.state === "new") {
          await window.minimal.transitionAttention(item.id, "seen");
        }
      }
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [items, onChanged]);

  const toggleExpand = useCallback((key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <aside className="attention-inbox" aria-label="Attention inbox" role="dialog">
      <header className="attention-inbox-header">
        <Bell size={14} aria-hidden />
        <h2>Inbox <span className="attention-inbox-count">{items.length}</span></h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Close inbox"
          onClick={onClose}
          title="Close inbox (Esc)"
        >
          <X size={15} />
        </button>
      </header>

      {error ? (
        <div className="attention-inbox-error" role="alert">{error}</div>
      ) : null}

      <ol className="attention-inbox-list">
        {groups.map(group => {
          const latest = group.rows[0]!;
          const expanded = expandedGroups.has(group.key);
          const olderCount = group.rows.length - 1;
          return (
            <li key={group.key} className="attention-inbox-group">
              <div className="attention-inbox-group-header">
                <span className={`attention-inbox-kind attention-inbox-kind-${group.kind}`}>
                  {group.kind}
                </span>
                <span className="attention-inbox-identity" title={group.issueIdentity}>
                  {group.issueIdentity}
                </span>
                <span className="attention-inbox-chip">
                  {group.rows.length}
                </span>
              </div>

              <AttentionRow item={latest} busy={busy} onTransition={transition} onSnooze={snooze} />

              {olderCount > 0 ? (
                <>
                  <button
                    type="button"
                    className="attention-inbox-disclosure"
                    aria-expanded={expanded}
                    onClick={() => toggleExpand(group.key)}
                  >
                    {expanded ? "Hide" : "Show"} {olderCount} older revision{olderCount > 1 ? "s" : ""}
                  </button>
                  {expanded ? group.rows.slice(1).map(row => (
                    <div key={row.id} className="attention-inbox-older">
                      <AttentionRow item={row} busy={busy} onTransition={transition} onSnooze={snooze} compact />
                    </div>
                  )) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ol>

      <footer className="attention-inbox-footer">
        <button
          type="button"
          className="attention-inbox-mark-all"
          onClick={markAllSeen}
          disabled={busy || items.every(item => item.state !== "new")}
          title="Mark every 'new' item as 'seen' in one pass"
        >
          <Eye size={13} aria-hidden />
          Mark all as seen
        </button>
      </footer>
    </aside>
  );
}

interface AttentionRowProps {
  item: AttentionItemView;
  busy: boolean;
  onTransition: (id: string, to: "seen" | "snoozed" | "dismissed" | "resolved") => void;
  onSnooze: (id: string) => void;
  compact?: boolean;
}

function AttentionRow({ item, busy, onTransition, onSnooze, compact }: AttentionRowProps) {
  const preview = compact ? null : safeParse(item.payloadJson);
  return (
    <div className={`attention-inbox-row attention-inbox-row-${item.state}${compact ? " compact" : ""}`}>
      <div className="attention-inbox-row-meta">
        <span className={`attention-inbox-state attention-inbox-state-${item.state}`}>
          {item.state} · r{item.revision}
        </span>
        <span className="attention-inbox-row-time" title={item.updatedAt}>
          {compact ? "" : new Date(item.updatedAt).toLocaleTimeString()}
        </span>
      </div>
      {preview ? (
        <pre className="attention-inbox-payload">{preview}</pre>
      ) : null}
      <div className="attention-inbox-actions">
        {item.state !== "seen" && item.state !== "snoozed" ? (
          <button
            type="button"
            onClick={() => onTransition(item.id, "seen")}
            disabled={busy}
            title="Mark seen"
          >
            <Eye size={12} aria-hidden />
            Seen
          </button>
        ) : null}
        {item.state === "seen" || item.state === "new" ? (
          <button
            type="button"
            onClick={() => onSnooze(item.id)}
            disabled={busy}
            title="Snooze for one hour"
          >
            <Clock size={12} aria-hidden />
            Snooze 1h
          </button>
        ) : null}
        {item.state !== "dismissed" ? (
          <button
            type="button"
            onClick={() => onTransition(item.id, "dismissed")}
            disabled={busy}
            title="Dismiss (presentation; the issue stays open until resolved)"
          >
            <X size={12} aria-hidden />
            Dismiss
          </button>
        ) : null}
        {item.state !== "resolved" ? (
          <button
            type="button"
            onClick={() => onTransition(item.id, "resolved")}
            disabled={busy}
            title="Resolve (authority — only the producing system should reach this)"
          >
            <Check size={12} aria-hidden />
            Resolve
          </button>
        ) : null}
      </div>
    </div>
  );
}
