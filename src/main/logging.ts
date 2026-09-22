import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Mutex } from "./mutex";
import type { RetentionClass } from "../release/diagnostic-scrubber";

export interface LogEntry {
  level: "info" | "warning" | "error";
  source: string;
  event: string;
  correlationId?: string;
  fields?: Record<string, unknown>;
  /**
   * M9.4: classify the retention class of the entry. Operational
   * entries may be rotated; `pending-decision`, `live-intent`, and
   * `recoverable-candidate` are protected by the day-rollover floor.
   * Defaults to `"operational"` when omitted.
   */
  retentionClass?: RetentionClass;
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

/** Maximum size of a single protected NDJSON file before writes refuse. */
const MAX_PROTECTED_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Daily NDJSON files; never log terminal/file payloads.
 *
 * M9.4: the day-rollover purge skips any file that contains at least
 * one non-operational entry (`RetentionClass` floor). A test seam
 * (`applyRetentionClasses`) lets tests mark a day's writes as
 * protected without restarting the logger.
 */
export class Logger implements LogSink {
  private mutex = new Mutex(256);
  private day = "";
  /** Day-keys whose current file contains at least one non-operational entry. */
  private protectedDays = new Set<string>();
  constructor(
    private directory: string,
    private retentionDays = 7,
    private clock = () => new Date(),
  ) {}
  /**
   * Test seam: declare that entries written on the current day should
   * be treated as protected by the retention floor. The caller can
   * pass any combination of the three protected classes; the day is
   * added to `protectedDays` so the day-rollover purge skips the file.
   * Idempotent; safe to call multiple times.
   */
  applyRetentionClasses(_classes: ReadonlyArray<RetentionClass>): void {
    const day = this.day || this.clock().toISOString().slice(0, 10);
    this.protectedDays.add(day);
  }
  /** Test seam: how many day-keys are currently protected. */
  protectedDayCount(): number {
    return this.protectedDays.size;
  }
  async write(entry: LogEntry): Promise<void> {
    await this.mutex.run(async () => {
      const now = this.clock();
      const day = now.toISOString().slice(0, 10);
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      if (day !== this.day) {
        const cutoff = now.getTime() - this.retentionDays * 86400000;
        for (const file of await readdir(this.directory)) {
          if (
            /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(file) &&
            Date.parse(file.slice(0, 10)) < cutoff
          ) {
            // M9.4 retention floor: a day file containing a
            // non-operational entry is never deleted. Other day
            // files (rotated past the window) are deleted normally.
            if (this.protectedDays.has(file.slice(0, 10))) continue;
            await rm(path.join(this.directory, file));
          }
        }
        this.day = day;
      }
      const retentionClass = entry.retentionClass ?? "operational";
      if (retentionClass !== "operational") {
        this.protectedDays.add(day);
        // Bound the protected file: refuse a protected write when the
        // day's file would exceed MAX_PROTECTED_FILE_BYTES. The refusal
        // is logged as a separate operational entry so a reviewer can
        // see the floor kicked in.
        const dayFile = path.join(this.directory, `${day}.ndjson`);
        try {
          const current = (await stat(dayFile)).size;
          if (current > MAX_PROTECTED_FILE_BYTES) {
            const fallback = {
              at: now.toISOString(),
              level: "warning",
              source: "logging",
              event: "retention-floor-blocked",
              correlationId: entry.correlationId || crypto.randomUUID(),
              retentionClass: "operational",
              fields: { day, currentBytes: current, capBytes: MAX_PROTECTED_FILE_BYTES },
            };
            await appendFile(dayFile, JSON.stringify(fallback) + "\n", { mode: 0o600 });
            return;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await appendFile(
        path.join(this.directory, `${day}.ndjson`),
        JSON.stringify({
          at: now.toISOString(),
          ...entry,
          retentionClass,
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
