import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { FileAction, SessionRecord } from "../shared/types";
import { log } from "./logging";
export class SessionFilesystem {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private registered = new Map<string, string>();
  private closed = false;
  constructor(private helper: string) {}
  private worker() {
    if (this.closed) throw new Error("The file service is closed");
    if (this.child) return this.child;
    const child = spawn("python3", ["-u", this.helper], { stdio: "pipe" });
    this.child = child;
    const fail = (error: Error) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.registered.clear();
      for (const item of this.pending.values()) item.reject(error);
      this.pending.clear();
      child.kill();
    };
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.on("exit", () =>
      fail(
        new Error(
          "The file service stopped. Refresh to reconnect; check files before retrying an edit.",
        ),
      ),
    );
    child.stderr.on("data", (data) =>
      log({
        level: "warning",
        source: "file-worker",
        event: "stderr",
        fields: { bytes: data.length },
      }),
    );
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.child !== child) return;
      try {
        const response = JSON.parse(line);
        const item = this.pending.get(response.id);
        this.pending.delete(response.id);
        if (response.error) item?.reject(new Error(response.error));
        else item?.resolve(response.result);
      } catch {
        fail(new Error("Invalid file service response"));
      }
    });
    return child;
  }
  private async request(request: object): Promise<any> {
    const child = this.worker();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ ...request, id }) + "\n", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  async register(
    sessionId: string,
    directory: string,
    identity?: string,
  ): Promise<{ directory: string; identity: string }> {
    const result = await this.request({
      action: "register",
      sessionId,
      directory,
      identity,
    });
    this.registered.set(sessionId, result.identity);
    return result;
  }
  async run(
    session: SessionRecord,
    request: FileAction | { action: "directory"; path: string },
  ): Promise<any> {
    this.worker();
    if (this.registered.get(session.id) !== session.identity)
      await this.register(session.id, session.directory, session.identity);
    try {
      return await this.request({ ...request, sessionId: session.id });
    } catch (error: any) {
      throw new Error(
        `${request.action} ${request.path || "."}: ${error.message}`,
      );
    }
  }
  async unregister(sessionId: string) {
    this.registered.delete(sessionId);
    await this.request({ action: "unregister", sessionId });
  }
  close() {
    this.closed = true;
    this.child?.stdin.end();
  }
}
