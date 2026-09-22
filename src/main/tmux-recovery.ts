import { readFile, stat } from "node:fs/promises";
import type { ProcessInfo } from "../shared/engine";
import { parseProcStat } from "./process-tree";

/** Recover missed SIGCHLD delivery; only the verified private server is signalled. */
export async function reapTmuxChildren(panes: Map<string, ProcessInfo>, serverPid: () => Promise<number>,
  root = "/proc", signal: typeof process.kill = process.kill) {
  const candidates = [...panes.values()].filter(pane => pane.dead && pane.exitCode === undefined && !pane.exitSignal);
  if (!candidates.length) return false;
  const read = async (pid: number) => {
    const directory = `${root}/${pid}`;
    try {
      const info = await stat(directory);
      return parseProcStat(await readFile(`${directory}/stat`, "utf8"), info.uid);
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")) return undefined;
      throw error;
    }
  };
  const pid = await serverPid();
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const server = await read(pid);
  if (!server || server.uid !== process.getuid!()) return false;
  for (const pane of candidates) {
    const child = await read(pane.pid);
    if (child?.state !== "Z" || child.parent !== pid || child.uid !== server.uid) continue;
    const current = await read(pid);
    if (current?.start !== server.start || current.uid !== server.uid) return false;
    // This asks tmux to reap its own children; no signal goes to a terminal job.
    signal(pid, "SIGCHLD");
    return true;
  }
  return false;
}
