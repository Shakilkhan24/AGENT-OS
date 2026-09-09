import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Attachment } from "../shared/engine";
import { log } from "./logging";
export function createAttachment(helper:string,args:string[],cols:number,rows:number,output:(token:string,data:string)=>void,exit:(token:string)=>void,env:NodeJS.ProcessEnv=process.env):Attachment {
    const token = randomUUID();
    const child: ChildProcessWithoutNullStreams = spawn(
      "python3",
      [
        "-u",
        helper,
        String(cols),
        String(rows),
        "tmux",
        ...args,
      ],
      { stdio: "pipe", env },
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
        outstanding += Buffer.byteLength(data);
        output(token, data);
        if (outstanding >= 256 * 1024) child.stdout.pause();
      } catch {
        /* An interrupted bridge line cannot become terminal input. */
      }
    });
    child.stderr.on("data", (data) =>
      log({
        level: "warning",
        source: "terminal-client",
        event: "stderr",
        fields: { bytes: data.length },
      }),
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
      if (queuedInput + Buffer.byteLength(message) > 4 * 1024 * 1024)
        return Promise.reject(
          new Error(
            "Terminal input is busy. Wait for the current paste to finish.",
          ),
        );
      queuedInput += Buffer.byteLength(message);
      return new Promise((resolve, reject) =>
        child.stdin.write(message, (error) => {
          queuedInput -= Buffer.byteLength(message);
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
