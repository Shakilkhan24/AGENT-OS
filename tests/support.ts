import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EngineAdapter, ProcessInfo } from "../src/shared/engine";
import type { TerminalRecord } from "../src/shared/types";
import { SessionService } from "../src/main/service";
import { SessionFilesystem } from "../src/main/filesystem";
import { Store } from "../src/main/store";

export class EngineDouble implements EngineAdapter {
  readonly capabilities = { id: "test", platforms: ["linux"], persistent: true, environment: true, pushStatus: false, processTree: false };
  processes = new Map<string, ProcessInfo>();
  created: TerminalRecord[] = [];
  removed: string[] = [];
  beforeCreate?: (terminal: TerminalRecord) => Promise<void>;
  inspectFailure?: Error;
  async initialize() {}
  async inspect() { if (this.inspectFailure) throw this.inspectFailure; return structuredClone(this.processes); }
  async create(terminal: TerminalRecord) {
    await this.beforeCreate?.(terminal);
    this.created.push(terminal);
    this.processes.set(terminal.id, { id: terminal.id, pid: 1000 + this.created.length, process: "test", cwd: terminal.cwd, dead: false });
  }
  async remove(id: string) { this.removed.push(id); this.processes.delete(id); }
  attach(): never { throw new Error("No terminal transport in this double"); }
}
export async function serviceFixture() {
  const base = await mkdtemp(path.join(tmpdir(), "minimal-services-"));
  const root = path.join(base, "project"); await mkdir(root);
  const store = new Store(path.join(base, "profile"));
  const engine = new EngineDouble();
  const files = new SessionFilesystem(path.resolve("helpers/filesystem.py"));
  const service = new SessionService(store, engine, files);
  await service.initialize();
  const session = (await service.createSession("Project", root)).sessions[0];
  return { base, root, store, engine, files, service, session, async cleanup() {
    service.close(); files.close(); await rm(base, { recursive: true, force: true });
  } };
}
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
