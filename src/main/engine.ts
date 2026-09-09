import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import path from "node:path";
import type { TerminalRecord } from "../shared/types";
const exec = promisify(execFile);
export interface ProcessInfo {
  id: string;
  pid: number;
  process: string;
  cwd: string;
  dead: boolean;
  exitCode?: number;
}
export interface Attachment {
  token: string;
  input(data: string): Promise<void>;
  resize(cols: number, rows: number): void;
  acknowledge(bytes: number): void;
  close(): void;
}
/** The only interface allowed to create, inspect, attach to or destroy terminal work. */
export interface TerminalEngine {
  initialize(): Promise<void>;
  inspect(): Promise<Map<string, ProcessInfo>>;
  create(terminal: TerminalRecord): Promise<void>;
  remove(id: string): Promise<void>;
  attach(
    id: string,
    cols: number,
    rows: number,
    output: (token: string, data: string) => void,
    exit: (token: string) => void,
  ): Attachment;
}
export class TmuxEngine implements TerminalEngine {
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
  private async command(...args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(
        "python3",
        [this.cleanExec, "tmux", ...this.args(...args)],
        {
          timeout: 10000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, TMUX: "" },
        },
      );
      return stdout.trimEnd();
    } catch (error: any) {
      throw new Error(String(error.stderr || error.message).trim());
    }
  }
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
    let text: string;
    try {
      text = await this.command(
        "list-panes",
        "-a",
        "-F",
        "#{session_name}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{pane_dead_status}",
      );
    } catch (error: any) {
      if (
        /no server running|error connecting.*No such file|Connection refused/.test(
          error.message,
        )
      )
        return new Map<string, ProcessInfo>();
      throw error;
    }
    const result = new Map<string, ProcessInfo>();
    for (const line of text.split("\n")) {
      const [name, pid, command, cwd, dead, code] = line.split("\t");
      if (!/^minimal_[a-f0-9-]{36}$/.test(name)) continue;
      const id = name.slice(8);
      result.set(id, {
        id,
        pid: Number(pid),
        process: command,
        cwd,
        dead: dead === "1",
        exitCode: code === "" ? undefined : Number(code),
      });
    }
    return result;
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
  attach(
    id: string,
    cols: number,
    rows: number,
    output: (token: string, data: string) => void,
    exit: (token: string) => void,
  ): Attachment {
    const token = randomUUID();
    const child: ChildProcessWithoutNullStreams = spawn(
      "python3",
      [
        "-u",
        this.helper,
        String(cols),
        String(rows),
        "tmux",
        ...this.args("attach-session", "-t", `=minimal_${id}`),
      ],
      { stdio: "pipe" },
    );
    let closed = false;
    let outstanding = 0;
    let queuedInput = 0;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const decoder = new StringDecoder("utf8");
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const data = decoder.write(
          Buffer.from(JSON.parse(line).data, "base64"),
        );
        if (!data || closed) return;
        outstanding += data.length;
        output(token, data);
        if (outstanding >= 256 * 1024) child.stdout.pause();
      } catch {
        /* An interrupted bridge line cannot become terminal input. */
      }
    });
    child.stderr.on("data", (data) =>
      console.error("Terminal client:", data.toString()),
    );
    const ended = () => {
      clearTimeout(closeTimer);
      if (!closed) {
        closed = true;
        exit(token);
      }
    };
    child.on("exit", ended);
    child.on("error", ended);
    child.stdin.on("error", () => {});
    const send = (request: object): Promise<void> => {
      if (closed)
        return Promise.reject(new Error("Terminal connection is closed"));
      const message = JSON.stringify(request) + "\n";
      if (queuedInput + message.length > 4 * 1024 * 1024)
        return Promise.reject(
          new Error(
            "Terminal input is busy. Wait for the current paste to finish.",
          ),
        );
      queuedInput += message.length;
      return new Promise((resolve, reject) =>
        child.stdin.write(message, (error) => {
          queuedInput -= message.length;
          if (error) reject(new Error("Terminal input connection closed"));
          else resolve();
        }),
      );
    };
    return {
      token,
      input: (data) => send({ data: Buffer.from(data).toString("base64") }),
      resize: (cols, rows) => {
        void send({ cols, rows }).catch(() => {});
      },
      acknowledge: (bytes) => {
        outstanding = Math.max(0, outstanding - bytes);
        if (outstanding < 64 * 1024) child.stdout.resume();
      },
      close: () => {
        if (!closed) {
          closed = true;
          child.stdin.end();
          child.stdout.resume();
          closeTimer = setTimeout(() => child.kill(), 1000);
          closeTimer.unref();
        }
      },
    };
  }
}
