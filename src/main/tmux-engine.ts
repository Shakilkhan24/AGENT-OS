import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import type { TerminalRecord } from "../shared/types";
import type { EngineAdapter, Attachment } from "../shared/engine";
import { createAttachment } from "./pty-attachment";
import { paneFormat, parsePanes } from "./tmux-protocol";
const exec = promisify(execFile);
export class TmuxEngine implements EngineAdapter {
  readonly capabilities = {id:"tmux",platforms:["linux"],persistent:true,environment:false,pushStatus:false,processTree:false} as const;
  readonly socket: string;
  private config: string;
  private cleanExec: string;
  constructor(
    private dataDirectory: string,
    private helper: string,
  ) {
    const hash = createHash("sha256")
      .update(dataDirectory)
      .digest("hex")
      .slice(0, 20);
    this.socket = `/tmp/minimal-${process.getuid!()}/${hash}.sock`;
    this.config = path.join(dataDirectory, "tmux.conf");
    this.cleanExec = path.join(path.dirname(helper), "exec_clean.py");
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
          env: { ...process.env, TMUX: "" },
        },
      );
      return stdout;
    } catch (error: any) {
      throw new Error(String(error.stderr || error.message).trim());
    }
  }
  private async command(...args:string[]):Promise<string> { return (await this.execute(...args)).toString("utf8").trimEnd(); }
  async initialize() {
    if (process.platform !== "linux")
      throw new Error("MINIMAL v1 requires Linux or WSL2 with WSLg.");
    await mkdir(path.dirname(this.socket), { recursive: true, mode: 0o700 });
    const directory = await stat(path.dirname(this.socket));
    if (directory.uid !== process.getuid!() || (directory.mode & 0o077) !== 0)
      throw new Error(
        "The private tmux socket directory has unsafe permissions.",
      );
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
    await writeFile(
      this.config,
      [
        "set -g remain-on-exit on",
        "set -g history-limit 20000",
        "set -g status off",
        "set -g mouse on",
        "set -g prefix None",
        "set -g prefix2 None",
        "unbind -a",
        "set -s escape-time 0",
        "set -g default-terminal xterm-256color",
        "set -g allow-rename off",
        "set -g automatic-rename off",
        "set -g destroy-unattached off",
        "set -g exit-empty on",
        "set -g default-shell /bin/bash",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    try {
      await exec("python3", [this.cleanExec, "tmux", "-V"]);
    } catch {
      throw new Error(
        "tmux and Python 3 are required. Install them, then reopen MINIMAL.",
      );
    }
  }
  async inspect() {
    try { return parsePanes(await this.execute("list-panes","-a","-F",paneFormat)); }
    catch(error) {
      if (error instanceof Error && /no server running|error connecting.*No such file|Connection refused/.test(error.message)) return new Map();
      throw error;
    }
  }
  async create(terminal: TerminalRecord) {
    // Separate argv bypasses shell interpretation by the parent and by tmux.
    const command = terminal.command.trim()
      ? ["/bin/bash", "-lic", terminal.command]
      : ["/bin/bash", "-l"];
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
      ...command,
    );
  }
  async remove(id: string) {
    try {
      await this.command("kill-session", "-t", `=minimal_${id}`);
    } catch (error: any) {
      if (
        !/can't find session|no server running|No such file|Connection refused/.test(
          error.message,
        )
      )
        throw error;
    }
  }
  attach(id:string,cols:number,rows:number,output:(token:string,data:string)=>void,exit:(token:string)=>void):Attachment {
    return createAttachment(this.helper,this.args("attach-session","-t",`=minimal_${id}`),cols,rows,output,exit);
  }
}
