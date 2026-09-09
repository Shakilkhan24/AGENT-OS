import { appendFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { Mutex } from "./mutex";

export interface LogEntry {
  level: "info" | "warning" | "error";
  source: string;
  event: string;
  correlationId?: string;
  fields?: Record<string, unknown>;
}
export interface LogSink {
  write(entry: LogEntry): Promise<void>;
}
const privateKey =
  /command|content|password|secret|token|clipboard|environment|^env$|^data$/i;
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[bounded]";
  if (typeof value === "string") return value.slice(0, 1024);
  if (Array.isArray(value))
    return value.slice(0, 32).map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 32)
        .map(([key, item]) => [
          key,
          privateKey.test(key) ? "[redacted]" : scrub(item, depth + 1),
        ]),
    );
  return value;
}
/** Daily NDJSON files; never log terminal/file payloads. */
export class Logger implements LogSink {
  private mutex = new Mutex(256);
  private day = "";
  constructor(
    private directory: string,
    private retentionDays = 7,
    private clock = () => new Date(),
  ) {}
  async write(entry: LogEntry): Promise<void> {
    await this.mutex.run(async () => {
      const now = this.clock();
      const day = now.toISOString().slice(0, 10);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (day !== this.day) {
        for (const file of await readdir(this.directory)) {
          if (
            /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file) &&
            Date.parse(file.slice(0, 10)) <
              now.getTime() - this.retentionDays * 86400000
          )
            await rm(path.join(this.directory, file));
        }
        this.day = day;
      }
      await appendFile(
        path.join(this.directory, `${day}.ndjson`),
        JSON.stringify({
          at: now.toISOString(),
          ...entry,
          correlationId: entry.correlationId || crypto.randomUUID(),
          fields: scrub(entry.fields),
        }) + "\n",
        { mode: 0o600 },
      );
    });
  }
}
let sink: LogSink | undefined;
export function configureLogging(logger: LogSink) {
  sink = logger;
}
export function log(entry: LogEntry) {
  const fallback = () =>
    process.stderr.write(
      JSON.stringify({
        at: new Date().toISOString(),
        level: "error",
        source: "logging",
        event: "log-unavailable",
        correlationId: entry.correlationId || crypto.randomUUID(),
      }) + "\n",
    );
  if (sink) void sink.write(entry).catch(fallback);
  else
    process.stderr.write(
      JSON.stringify({
        at: new Date().toISOString(),
        ...entry,
        correlationId: entry.correlationId || crypto.randomUUID(),
        fields: scrub(entry.fields),
      }) + "\n",
    );
}
