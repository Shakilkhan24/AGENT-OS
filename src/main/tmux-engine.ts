import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TerminalRecord } from "../shared/types";
import type { EngineAdapter, Attachment, ProcessInfo } from "../shared/engine";
import { defaultSettings, type Settings } from "../shared/settings";
import { resolveEnvironment } from "../shared/env-profiles";
import { AppError } from "../shared/errors";
import { createAttachment } from "./pty-attachment";
import { paneFormat, parsePanes } from "./tmux-protocol";
import { privateConfig, privateDirectory, profilePaths } from "./profile-runtime";
import { TmuxWatcher } from "./tmux-watcher";
import { stopTerminal, type StopProgress } from "./stop-policy";
import type { StopPolicy } from "../shared/events";
const exec = promisify(execFile);
export class TmuxEngine implements EngineAdapter {
  readonly capabilities = {id:"tmux",platforms:["linux"],persistent:true,environment:true,pushStatus:true,processTree:true} as const;
  readonly socket: string;
  private config: string;
  private cleanExec: string;
  private paths: ReturnType<typeof profilePaths>;
  private watcher: TmuxWatcher;
  private environment() {
    return { ...process.env, TMUX: "", TMUX_TMPDIR: this.paths.runtime, MINIMAL_TMUX_CONF: this.config };
  }
  constructor(
    private dataDirectory: string,
    private helper: string,
    private settings: Settings = defaultSettings,
  ) {
    this.paths = profilePaths(dataDirectory);
    this.socket = this.paths.socket;
    this.config = this.paths.config;
    this.cleanExec = path.join(path.dirname(helper), "exec_clean.py");
    this.watcher = new TmuxWatcher("python3", [this.cleanExec, "tmux", ...this.args("wait-for", `minimal-exited-${this.paths.key}`)], this.environment());
  }
  private args(...args: string[]) {
    return ["-S", this.socket, "-f", this.config, ...args];
  }
  private async execute(...args: string[]): Promise<Buffer> {
    try {
      const { stdout } = await exec(
        "python3",
        [this.cleanExec, "tmux", ...this.args(...args)],
        {
          encoding: "buffer",
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
          env: this.environment(),
        },
      );
      return stdout;
    } catch (error) {
      const failure = error as Error & { stderr?: Buffer; killed?: boolean };
      if (failure.killed) throw new AppError("TIMEOUT", "The tmux operation exceeded 10 seconds", { sourceId: "tmux", outcomeUnknown: true });
      throw new AppError("UNAVAILABLE", String(failure.stderr || failure.message).trim().slice(0, 4096), { sourceId: "tmux", retryable: true });
    }
  }
  private async command(...args:string[]):Promise<string> { return (await this.execute(...args)).toString("utf8").trimEnd(); }
  async initialize() {
    if (process.platform !== "linux")
      throw new Error("MINIMAL requires Linux or WSL2 with WSLg.");
    await privateDirectory(this.paths.parent);
    await privateDirectory(this.paths.runtime);
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await privateConfig(
      this.config,
      [
        "set -g remain-on-exit on",
        `set -g history-limit ${this.settings.historyLines}`,
        "set -g status off",
        "set -g mouse on",
        "set -g prefix None",
        "set -g prefix2 None",
        "unbind -a -q",
        "set -s escape-time 0",
        "set -g default-terminal xterm-256color",
        "set -g allow-rename off",
        "set -g automatic-rename off",
        "set -g destroy-unattached off",
        "set -g exit-empty on",
        "set -g default-shell /bin/bash",
        `set-hook -g pane-died 'wait-for -S minimal-exited-${this.paths.key}'`,
        `set-hook -g pane-exited 'wait-for -S minimal-exited-${this.paths.key}'`,
        "",
      ].join("\n"),
    );
    try {
      await exec("python3", [this.cleanExec, "tmux", "-V"], { timeout: 10000 });
    } catch {
      throw new Error(
        "tmux and Python 3 are required. Install them, then reopen MINIMAL.",
      );
    }
    // Update hooks on an existing v1 server without changing its socket or processes.
    if ((await this.inspect()).size) await this.command("source-file", this.config);
  }
  async inspect(): Promise<Map<string, ProcessInfo>> {
    try { return parsePanes(await this.execute("list-panes","-a","-F",paneFormat)); }
    catch(error) {
      if (error instanceof Error && /no server running|error connecting.*No such file|Connection refused/.test(error.message)) return new Map<string, ProcessInfo>();
      throw error;
    }
  }
  async create(terminal: TerminalRecord) {
    // Separate argv bypasses shell interpretation by the parent and by tmux.
    const clean = this.settings.shellMode === "clean";
    const command = terminal.command.trim()
      ? clean ? ["/bin/bash", "--noprofile", "--norc", "-ic", terminal.command] : ["/bin/bash", "-lic", terminal.command]
      : clean ? ["/bin/bash", "--noprofile", "--norc", "-i"] : ["/bin/bash", "-l"];
    const environment = { ...resolveEnvironment(process.env, undefined, terminal.env),
      TMUX_TMPDIR: this.paths.runtime, MINIMAL_TMUX_CONF: this.config };
    await this.command(
      "new-session",
      "-d",
      "-s",
      `minimal_${terminal.id}`,
      "-c",
      terminal.cwd,
      "-x",
      "100",
      "-y",
      "30",
      ...Object.entries(environment).flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      ...command,
    );
  }
  async remove(id: string) {
    try {
      await this.command("kill-session", "-t", `=minimal_${id}`);
    } catch (error) {
      if (
        !/can't find session|no server running|No such file|Connection refused/.test(
          error instanceof Error ? error.message : String(error),
        )
      )
        throw error;
    }
  }
  attach(id:string,cols:number,rows:number,output:(token:string,data:string)=>void,exit:(token:string)=>void):Attachment {
    return createAttachment(this.helper,this.args("attach-session","-t",`=minimal_${id}`),cols,rows,output,exit,this.environment());
  }
  onChange(listener: () => void) { return this.watcher.subscribe(listener); }
  async stop(id: string, policy: StopPolicy, progress: StopProgress) {
    let pane: ProcessInfo | undefined;
    try { pane = (await this.inspect()).get(id); } catch (error) { if (policy !== "force") throw error; }
    return stopTerminal(pane, policy, this.settings.gracefulStopMs,
      () => this.command("send-keys", "-t", `=minimal_${id}:`, "C-c").then(() => {}),
      () => this.remove(id), progress);
  }
  close() { this.watcher.close(); }
}
