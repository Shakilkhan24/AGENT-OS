import { randomUUID } from "node:crypto";
import { z } from "zod";
import { nameSchema, presetSchema, Store } from "./store";
import type { TerminalEngine } from "./engine";
import { SessionFilesystem } from "./filesystem";
import { commandLabel } from "../shared/commands";
import type {
  FileAction,
  Preset,
  SessionRecord,
  Snapshot,
  State,
  LaunchRequest,
  LaunchResult,
  TerminalRecord,
} from "../shared/types";
const launchSchema = z
  .object({
    command: z
      .string()
      .max(8192)
      .refine((s) => !s.includes("\0"))
      .optional(),
    presetId: z.string().uuid().optional(),
    label: z.string().trim().max(70).optional(),
    count: z.number().int().min(1).max(32).default(1),
    cwd: z.string().max(4096).default(""),
    savePresetAs: nameSchema.optional(),
  })
  .refine(
    (value) => value.command !== undefined || value.presetId !== undefined,
    "Enter a command or choose a preset",
  );
export class SessionService {
  private state!: State;
  private queue: Promise<unknown> = Promise.resolve();
  private sequence = 0;
  constructor(
    private store: Store,
    readonly engine: TerminalEngine,
    readonly filesystem: SessionFilesystem,
  ) {}
  async initialize() {
    this.state = await this.store.load();
    await this.engine.initialize();
    await this.reconcile();
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }
  private session(id: string): SessionRecord {
    const session = this.state.sessions.find(
      (item) => item.id === id && !item.deleting,
    );
    if (!session) throw new Error("Session no longer exists");
    return session;
  }
  private async persist(next: State) {
    await this.store.save(next);
    this.state = next;
  }
  private async reconcile() {
    // Deletions are journaled before touching the engine, and are safe to retry.
    for (const session of [...this.state.sessions]) {
      for (const terminal of [...session.terminals]) {
        if (session.deleting || terminal.deleting) {
          await this.engine.remove(terminal.id);
          const next = structuredClone(this.state);
          next.sessions.find((s) => s.id === session.id)!.terminals =
            next.sessions
              .find((s) => s.id === session.id)!
              .terminals.filter((t) => t.id !== terminal.id);
          await this.persist(next);
        }
      }
      if (session.deleting) {
        const next = structuredClone(this.state);
        next.sessions = next.sessions.filter((s) => s.id !== session.id);
        await this.persist(next);
        await this.filesystem.unregister(session.id);
      }
    }
  }
  private async view(): Promise<Snapshot> {
    const sequence = ++this.sequence;
    try {
      await this.reconcile();
      const processes = await this.engine.inspect();
      return {
        sequence,
        presets: structuredClone(this.state.presets),
        sessions: this.state.sessions.map((session) => ({
          ...session,
          terminals: session.terminals.map((terminal) => {
            const live = processes.get(terminal.id);
            return {
              ...terminal,
              status: terminal.deleting
                ? "deleting"
                : !live
                  ? "missing"
                  : live.dead
                    ? "exited"
                    : "running",
              pid: live?.pid,
              process: live?.process,
              currentDirectory: live?.cwd,
              exitCode: live?.exitCode,
            };
          }),
        })),
      };
    } catch (error: any) {
      return {
        sequence,
        presets: this.state.presets,
        sessions: this.state.sessions.map((session) => ({
          ...session,
          terminals: session.terminals.map((terminal) => ({
            ...terminal,
            status: terminal.deleting ? "deleting" : "unknown",
          })),
        })),
        engineError: error.message,
      };
    }
  }
  snapshot() {
    return this.serial(() => this.view());
  }
  createSession(name: string, directory: string) {
    return this.serial(async () => {
      name = nameSchema.parse(name);
      directory = z.string().min(1).max(4096).parse(directory);
      const id = randomUUID();
      const binding = await this.filesystem.register(id, directory);
      const next = structuredClone(this.state);
      next.sessions.push({
        id,
        name,
        ...binding,
        createdAt: new Date().toISOString(),
        terminals: [],
      });
      await this.persist(next);
      return this.view();
    });
  }
  renameSession(id: string, name: string) {
    return this.serial(async () => {
      this.session(id);
      const next = structuredClone(this.state);
      next.sessions.find((s) => s.id === id)!.name = nameSchema.parse(name);
      await this.persist(next);
      return this.view();
    });
  }
  deleteSession(id: string) {
    return this.serial(async () => {
      this.session(id);
      const next = structuredClone(this.state);
      next.sessions.find((s) => s.id === id)!.deleting = true;
      await this.persist(next);
      await this.reconcile();
      return this.view();
    });
  }
  createTerminals(
    sessionId: string,
    presetId: string,
    count: number,
    relativeCwd: string,
  ) {
    return this.launchTerminals(sessionId, {
      presetId,
      count,
      cwd: relativeCwd,
    });
  }
  launchTerminals(
    sessionId: string,
    request: LaunchRequest,
  ): Promise<LaunchResult> {
    return this.serial(async () => {
      const session = this.session(sessionId);
      const {
        count,
        cwd: relativeCwd,
        ...options
      } = launchSchema.parse(request);
      if (session.terminals.length + count > 128)
        throw new Error("A session can contain at most 128 terminals");
      const preset = this.state.presets.find((p) => p.id === options.presetId);
      if (options.presetId && !preset)
        throw new Error("Choose an existing preset");
      const command = options.command ?? preset!.command;
      const cwd = await this.filesystem.run(session, {
        action: "directory",
        path: z.string().max(4096).parse(relativeCwd),
      });
      const next = structuredClone(this.state);
      const target = next.sessions.find((s) => s.id === sessionId)!;
      const used = new Set(target.terminals.map((t) => t.label));
      let suffix = 1;
      const baseLabel = (
        options.label ||
        (options.command === undefined ? preset?.name : undefined) ||
        commandLabel(command)
      ).slice(0, 70);
      const terminals: TerminalRecord[] = Array.from({ length: count }, () => {
        while (used.has(`${baseLabel} ${suffix}`)) suffix++;
        const label = `${baseLabel} ${suffix++}`;
        used.add(label);
        return {
          id: randomUUID(),
          label,
          cwd,
          command,
          createdAt: new Date().toISOString(),
        };
      });
      target.terminals.push(...terminals);
      if (options.savePresetAs) {
        const existing = next.presets.find(
          (p) => p.name === options.savePresetAs && p.command === command,
        );
        if (!existing) {
          if (next.presets.length >= 100)
            throw new Error("Remove an unused preset before saving another");
          next.presets.push({
            id: randomUUID(),
            name: options.savePresetAs,
            command,
          });
        }
      }
      // Write-ahead records make a crash between any two launches reconcilable.
      await this.persist(next);
      const launchErrors: LaunchResult["launchErrors"] = [];
      for (const terminal of terminals) {
        try {
          await this.engine.create(terminal);
        } catch (error: any) {
          launchErrors.push({ terminalId: terminal.id, error: error.message });
        }
      }
      if (launchErrors.length) {
        const failed = structuredClone(this.state);
        for (const failure of launchErrors)
          failed.sessions
            .find((s) => s.id === sessionId)!
            .terminals.find((t) => t.id === failure.terminalId)!.launchError =
            failure.error;
        await this.persist(failed);
      }
      return {
        ...(await this.view()),
        terminalIds: terminals.map((t) => t.id),
        launchErrors,
      };
    });
  }
  renameTerminal(sessionId: string, terminalId: string, label: string) {
    return this.serial(async () => {
      this.session(sessionId);
      const next = structuredClone(this.state);
      const terminal = next.sessions
        .find((s) => s.id === sessionId)!
        .terminals.find((t) => t.id === terminalId);
      if (!terminal) throw new Error("Terminal no longer exists");
      terminal.label = nameSchema.parse(label);
      await this.persist(next);
      return this.view();
    });
  }
  deleteTerminal(sessionId: string, terminalId: string) {
    return this.serial(async () => {
      this.session(sessionId);
      const next = structuredClone(this.state);
      const terminal = next.sessions
        .find((s) => s.id === sessionId)!
        .terminals.find((t) => t.id === terminalId);
      if (!terminal) throw new Error("Terminal no longer exists");
      terminal.deleting = true;
      await this.persist(next);
      await this.reconcile();
      return this.view();
    });
  }
  savePresets(presets: Preset[]) {
    return this.serial(async () => {
      presets = z.array(presetSchema).min(1).max(100).parse(presets);
      if (new Set(presets.map((p) => p.id)).size !== presets.length)
        throw new Error("Preset IDs must be unique");
      const next = structuredClone(this.state);
      next.presets = presets;
      await this.persist(next);
      return this.view();
    });
  }
  files(sessionId: string, request: FileAction) {
    return this.filesystem.run(this.session(sessionId), request);
  }
  async requireTerminal(id: string) {
    await this.queue;
    const terminal = this.state.sessions
      .filter((s) => !s.deleting)
      .flatMap((s) => s.terminals)
      .find((t) => t.id === id && !t.deleting);
    if (!terminal) throw new Error("Terminal no longer exists");
    if (!(await this.engine.inspect()).has(id))
      throw new Error(
        "This terminal is no longer running. Launch a new terminal to start work.",
      );
    return terminal;
  }
}
