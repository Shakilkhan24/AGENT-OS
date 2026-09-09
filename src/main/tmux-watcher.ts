import { spawn, type ChildProcess } from "node:child_process";
import { log } from "./logging";

/** A disposable wait-for client. Closing it never signals the tmux server. */
export class TmuxWatcher {
  private listeners = new Set<() => void>();
  private child?: ChildProcess;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private executable: string, private args: string[], private env: NodeJS.ProcessEnv) {}
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    this.start();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) this.close(); };
  }
  private start() {
    if (!this.listeners.size || this.child || this.timer) return;
    const child = spawn(this.executable, this.args, { env: this.env, stdio: "ignore" });
    this.child = child;
    let finished = false;
    const finish = (success: boolean) => {
      if (finished) return;
      finished = true;
      if (this.child !== child) return;
      this.child = undefined;
      if (success) for (const listener of this.listeners) {
        try { listener(); } catch {
          log({ level: "warning", source: "tmux-watcher", event: "subscriber-failed" });
        }
      }
      if (this.listeners.size) {
        this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, success ? 0 : 500);
        this.timer.unref();
      }
    };
    child.once("exit", (code) => finish(code === 0));
    child.once("error", () => finish(false));
  }
  close() {
    this.listeners.clear();
    clearTimeout(this.timer); this.timer = undefined;
    const child = this.child; this.child = undefined;
    child?.kill();
  }
}
