import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot, TerminalView } from "../shared/types";

/** Push hints trigger coalesced refreshes; fallback polls cannot overwrite a newer response. */
export function useWorkspace(report: (error: unknown) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    sequence: 0,
    sessions: [],
    presets: [],
  });
  const [ready, setReady] = useState(false);
  const latest = useRef(0);
  const accept = useCallback((next: Snapshot) => {
    if (next.sequence < latest.current) return;
    latest.current = next.sequence;
    setSnapshot((prev) => (shallowEqual(prev, next) ? prev : next));
    setReady(true);
  }, []);
  useEffect(() => {
    let stopped = false;
    let polling = false, invalidated = false;
    let timer: ReturnType<typeof setTimeout>;
    const unsubscribe = window.minimal.onProtocolFailure(failure => report(new Error(failure.message)));
    const poll = async () => {
      if (stopped) return;
      if (polling) { invalidated = true; return; }
      clearTimeout(timer); polling = true;
      try {
        const next = await window.minimal.snapshot();
        if (!stopped) accept(next);
      } catch (error) {
        if (!stopped) report(error);
      }
      polling = false;
      if (!stopped) timer = setTimeout(poll, invalidated ? 25 : 4000);
      invalidated = false;
    };
    const unsubscribeChanges = window.minimal.onWorkspaceChanged(() => {
      if (polling) { invalidated = true; return; }
      clearTimeout(timer); timer = setTimeout(poll, 25);
    });
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeChanges();
    };
  }, [accept, report]);
  return { snapshot, ready, accept };
}

/**
 * Cheap structural equality for the parts of a snapshot that the UI actually
 * observes. Skipping setState when nothing changed avoids re-rendering the
 * entire App tree every 4 s while the user is idle.
 */
function shallowEqual(a: Snapshot, b: Snapshot): boolean {
  if (a === b) return true;
  if (a.sequence === b.sequence) return true;
  if (a.presets !== b.presets || a.sessions.length !== b.sessions.length) return false;
  if (a.engineError !== b.engineError || a.envProfiles !== b.envProfiles || a.hooks !== b.hooks || a.launches !== b.launches) return false;
  for (let i = 0; i < a.sessions.length; i++) {
    const left = a.sessions[i];
    const right = b.sessions[i];
    if (left.id !== right.id || left.name !== right.name || left.directory !== right.directory
      || left.deleting !== right.deleting || left.metadata !== right.metadata
      || left.terminals.length !== right.terminals.length) return false;
    if (!terminalViewsEqual(left.terminals, right.terminals)) return false;
  }
  return true;
}

function terminalViewsEqual(a: TerminalView[], b: TerminalView[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (left.id !== right.id || left.label !== right.label || left.status !== right.status
      || left.exitCode !== right.exitCode || left.exitSignal !== right.exitSignal
      || left.deleting !== right.deleting || left.launchState !== right.launchState
      || left.endedAt !== right.endedAt || left.startedAt !== right.startedAt
      || left.promptAnchors !== right.promptAnchors
      || left.metadata !== right.metadata
      || left.env !== right.env) return false;
  }
  return true;
}
