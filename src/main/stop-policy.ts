import { setTimeout as delay } from "node:timers/promises";
import type { ProcessInfo, StopReport } from "../shared/engine";
import type { StopPolicy } from "../shared/events";
import { ProcessTree } from "./process-tree";

export type StopProgress = (stage: "interrupt" | "term" | "kill" | "removed", pids: number[]) => void;
export async function stopTerminal(pane: ProcessInfo | undefined, policy: StopPolicy, graceMs: number,
  interrupt: () => Promise<void>, remove: () => Promise<void>, progress: StopProgress): Promise<StopReport> {
  const signalled = new Set<number>();
  let tree: ProcessTree | undefined;
  if (pane && !pane.dead) {
    try { tree = await new ProcessTree().capture(pane.pid, pane.tty); }
    catch (error) { if (policy !== "force") throw error; }
  }
  const settle = async (ms: number) => {
    const until = performance.now() + ms;
    while (tree && (await tree.remaining()).length && performance.now() < until) await delay(25);
  };
  if (tree && policy !== "force") {
    if (policy === "graceful") {
      await interrupt(); progress("interrupt", await tree.remaining());
      await settle(graceMs);
    }
    if (policy === "graceful" || policy === "term") {
      await tree.refresh();
      const pids = await tree.signal("SIGTERM"); pids.forEach(id => signalled.add(id)); progress("term", pids);
      await settle(graceMs);
    }
    await tree.refresh();
    const pids = await tree.signal("SIGKILL"); pids.forEach(id => signalled.add(id)); progress("kill", pids);
    await settle(150);
  }
  await remove();
  progress("removed", []);
  return { policy, signalled: [...signalled], remaining: tree ? await tree.remaining() : [],
    bestEffort: true, accountingIncomplete: tree?.incomplete ?? Boolean(pane && !pane.dead) };
}
