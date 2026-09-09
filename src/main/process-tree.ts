import { opendir, readFile, readlink, stat } from "node:fs/promises";
import path from "node:path";

export interface ProcessIdentity { pid: number; parent: number; start: string; uid: number; state: string }
export function parseProcStat(text: string, uid: number): ProcessIdentity {
  const end = text.lastIndexOf(")");
  const pid = Number(text.slice(0, text.indexOf(" ")));
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (end < 0 || !Number.isSafeInteger(pid) || pid < 1 || fields.length < 20 || !/^\d+$/.test(fields[19]) || !/^\d+$/.test(fields[1]))
    throw new Error("Invalid process identity");
  return { pid, parent: Number(fields[1]), start: fields[19], uid, state: fields[0] };
}

/** Best effort Linux accounting. Identity is rechecked immediately before every signal. */
export class ProcessTree {
  private identities = new Map<number, ProcessIdentity>();
  incomplete = false;
  constructor(private root = "/proc", private uid = process.getuid!(),
    private kill: (pid: number, signal: NodeJS.Signals) => void = process.kill) {}
  private async read(pid: number) {
    const directory = path.join(this.root, String(pid));
    try {
      const [text, info] = await Promise.all([readFile(`${directory}/stat`, "utf8"), stat(directory)]);
      return parseProcStat(text, info.uid);
    } catch (error) {
      if (!["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code || "")) this.incomplete = true;
      return undefined;
    }
  }
  async capture(pid: number, tty?: string) {
    const anchor = await this.read(pid);
    if (!anchor || anchor.uid !== this.uid || pid === process.pid)
      throw new Error("Cannot verify the terminal process identity");
    if (tty) {
      const actual = await readlink(path.join(this.root, String(pid), "fd/0")).catch(() => "");
      if (actual !== tty) throw new Error("Terminal process ownership changed");
    }
    this.identities.set(pid, anchor);
    await this.refresh();
    return this;
  }
  async refresh() {
    const all: ProcessIdentity[] = [];
    const directory = await opendir(this.root);
    let batch: Promise<ProcessIdentity | undefined>[] = [];
    let count = 0;
    const collect = async () => { for (const value of await Promise.all(batch)) if (value?.uid === this.uid) all.push(value); batch = []; };
    for await (const entry of directory) {
      if (!/^\d+$/.test(entry.name)) continue;
      if (++count > 16384) { this.incomplete = true; break; }
      batch.push(this.read(Number(entry.name)));
      if (batch.length === 32) await collect();
    }
    await collect();
    const alive = new Set(all.filter(p => this.identities.get(p.pid)?.start === p.start).map(p => p.pid));
    let changed = true;
    while (changed && this.identities.size < 4096) {
      changed = false;
      for (const item of all) if (item.pid !== process.pid && alive.has(item.parent) && !alive.has(item.pid)) {
        this.identities.set(item.pid, item); alive.add(item.pid); changed = true;
        if (this.identities.size >= 4096) { this.incomplete = true; break; }
      }
    }
  }
  async remaining() {
    const live: number[] = [];
    for (const identity of this.identities.values()) {
      const current = await this.read(identity.pid);
      if (current?.uid === identity.uid && current.start === identity.start && !["Z", "X"].includes(current.state)) live.push(identity.pid);
    }
    return live;
  }
  async signal(signal: NodeJS.Signals) {
    const signalled: number[] = [];
    for (const identity of [...this.identities.values()].reverse()) {
      const current = await this.read(identity.pid);
      if (current?.uid !== identity.uid || current.start !== identity.start || ["Z", "X"].includes(current.state)) continue;
      try { this.kill(identity.pid, signal); signalled.push(identity.pid); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") this.incomplete = true; }
    }
    return signalled;
  }
}
