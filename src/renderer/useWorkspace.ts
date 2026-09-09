import { useCallback, useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types";

/** Polls cannot overwrite a newer mutation response when IPC resolves out of order. */
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
    setSnapshot(next);
    setReady(true);
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await window.minimal.snapshot();
        if (!stopped) accept(next);
      } catch (error) {
        if (!stopped) report(error);
      }
      if (!stopped) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [accept, report]);
  return { snapshot, ready, accept };
}
