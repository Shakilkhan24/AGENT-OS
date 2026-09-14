/**
 * Per-attachment bounded input queue. Owned by the runtime so the bytes
 * survive any view churn: switching tabs, remounting the renderer, or
 * losing the renderer entirely must not cancel accepted input that has
 * already been admitted (per M1.5).
 *
 *   - `enqueue(token, data)` admits a chunk; once admitted the bytes are
 *     owned by the terminal and the caller has no further lever.
 *   - The queue is bounded by UTF-8 byte count, not chunk count. A single
 *     1.5 MiB paste shares the budget with many small keypresses.
 *   - `cancel(token)` drops unsubmitted bytes for that terminal. It never
 *     touches in-flight chunks; tmux has already received them.
 *   - The progress callback fires whenever admitted bytes change so the
 *     renderer can show "x of y bytes queued". The callback is bounded by
 *     `progressIntervalMs` to coalesce burst signals.
 *   - The queue never retries a failed delivery. tmux's bridge either
 *     accepted the bytes or it did not; the failure is surfaced verbatim
 *     and the queue advances.
 *   - No audit log captures paste content; only `bytes` counts are
 *     surfaced.
 */
import { AppError } from "../shared/errors";
import { utf8Bytes } from "../shared/terminal-flow";

export interface InputQueueProgress {
  token: string;
  queued: number;
  delivered: number;
}

export interface InputQueueOptions {
  /** UTF-8 bytes admitted per terminal across all in-flight chunks. */
  budgetBytes?: number;
  /** Coalesce progress signals to at most one per interval. */
  progressIntervalMs?: number;
}

const DEFAULT_BUDGET = 2 * 1024 * 1024;
const DEFAULT_PROGRESS_MS = 25;

export class TerminalInputQueue {
  private readonly budget: number;
  private readonly progressIntervalMs: number;
  private readonly queues = new Map<string, { data: string; bytes: number }[]>();
  private readonly queued = new Map<string, number>();
  private readonly delivered = new Map<string, number>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly progressListeners = new Set<(progress: InputQueueProgress[]) => void>();
  private lastEmitted = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private dirty = false;
  private closed = false;

  constructor(
    private readonly bridge: (token: string, data: string) => Promise<void>,
    options: InputQueueOptions = {},
  ) {
    this.budget = options.budgetBytes ?? DEFAULT_BUDGET;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_MS;
  }

  /**
   * Submit `data` for delivery to the terminal identified by `token`. The
   * returned promise resolves the moment the bytes are admitted into the
   * queue, not when the bridge has acknowledged them. The runtime owns the
   * admitted bytes; cancelling the returned promise does not abort delivery.
   * Use `cancel(token)` for that.
   */
  enqueue(token: string, data: string): { admitted: number } {
    if (this.closed) throw new AppError("UNAVAILABLE", "Input queue is closing");
    if (!data) return { admitted: 0 };
    const bytes = utf8Bytes(data);
    if (bytes > this.budget)
      throw new AppError("BUSY", "Paste exceeds the terminal input budget; paste a smaller selection", { retryable: true });
    const current = this.queued.get(token) ?? 0;
    if (current + bytes > this.budget)
      throw new AppError("BUSY", "Terminal input is busy; wait for the current paste to finish", { retryable: true });
    const queue = this.queues.get(token);
    if (queue) queue.push({ data, bytes });
    else this.queues.set(token, [{ data, bytes }]);
    this.queued.set(token, current + bytes);
    this.ensureTail(token);
    this.markDirty();
    this.scheduleFlush();
    return { admitted: bytes };
  }

  /** Drop all unsubmitted bytes for `token`. In-flight bytes keep flowing. */
  cancel(token: string): number {
    const dropped = this.queued.get(token) ?? 0;
    this.queues.delete(token);
    this.queued.delete(token);
    this.delivered.delete(token);
    this.tails.delete(token);
    this.markDirty();
    this.emitProgress();
    return dropped;
  }

  progress(token: string): InputQueueProgress {
    return {
      token,
      queued: this.queued.get(token) ?? 0,
      delivered: this.delivered.get(token) ?? 0,
    };
  }

  onProgress(listener: (progress: InputQueueProgress[]) => void): () => void {
    this.progressListeners.add(listener);
    return () => { this.progressListeners.delete(listener); };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Mark closing so further enqueues are rejected, but allow already-queued
    // bytes to drain — admitted input must be delivered even when the
    // runtime is being torn down.
    this.closed = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const tails = [...this.tails.values()];
    await Promise.allSettled(tails);
    this.queues.clear();
    this.queued.clear();
    this.delivered.clear();
    this.tails.clear();
    this.dirty = false;
  }

  private ensureTail(token: string) {
    if (this.tails.has(token)) return;
    const tail = this.drain(token).catch(() => {});
    // A failed drain must not poison subsequent input or replay the failed chunk.
    this.tails.set(token, tail);
    void tail.finally(() => {
      if (this.tails.get(token) === tail) this.tails.delete(token);
    });
  }

  private async drain(token: string) {
    // Drain admitted bytes until the queue is empty. Closing the queue does
    // not abort this loop — admitted bytes must reach the bridge even on
    // shutdown (per M1.5). New enqueues are rejected, but tail draining
    // continues until the queue empties or the bridge fails.
    while (true) {
      const queue = this.queues.get(token);
      const next = queue?.shift();
      if (!next) return;
      try {
        await this.bridge(token, next.data);
        const delivered = (this.delivered.get(token) ?? 0) + next.bytes;
        this.delivered.set(token, delivered);
        const remaining = (this.queued.get(token) ?? 0) - next.bytes;
        if (remaining <= 0) this.queued.delete(token);
        else this.queued.set(token, remaining);
      } catch (error) {
        // Failures are surfaced verbatim. The queue does not retry ambiguous
        // delivery; the bridge either wrote the bytes or it did not.
        this.queues.delete(token);
        this.queued.delete(token);
        this.markDirty();
        this.emitError(token, error);
        return;
      }
      this.markDirty();
    }
  }

  private markDirty() { this.dirty = true; }

  private scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    const elapsed = Date.now() - this.lastEmitted;
    const delay = elapsed >= this.progressIntervalMs ? 0 : this.progressIntervalMs - elapsed;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.emitProgress();
    }, delay);
  }

  private emitProgress() {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastEmitted = Date.now();
    const tokens = new Set<string>([...this.queued.keys(), ...this.delivered.keys()]);
    const snapshot: InputQueueProgress[] = [];
    for (const token of tokens)
      snapshot.push({ token, queued: this.queued.get(token) ?? 0, delivered: this.delivered.get(token) ?? 0 });
    if (snapshot.length === 0) return;
    for (const listener of this.progressListeners) {
      try { listener(snapshot); } catch { /* listener failure must not stop delivery */ }
    }
  }

  private emitError(token: string, error: unknown) {
    // Surface without leaking paste content; the runtime logs the failure
    // with byte counts, not the data itself.
    const failure = error instanceof Error ? error.message : String(error);
    for (const listener of this.progressListeners) {
      try { listener([{ token, queued: 0, delivered: this.delivered.get(token) ?? 0 }]); } catch { /* ignore */ }
    }
    if (process.env.NODE_ENV !== "test") {
      const message = `terminal input delivery failed for token ${token} (${failure})`;
      if (typeof process.stderr?.write === "function") process.stderr.write(message + "\n");
    }
  }
}
