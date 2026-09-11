/**
 * Trailing-edge debouncer with cooperative flushing.
 *
 * `schedule(...)` collapses overlapping calls into one: every call inside the
 * window receives the latest arguments and a single shared promise that
 * resolves when the underlying work completes. `flush()` drains any pending
 * work synchronously and returns a promise that resolves once it's on disk.
 *
 * Used to coalesce bursts of `state.json` and event-journal writes so we
 * don't pay an `fsync` per mutation while preserving the latest intent for
 * crash recovery.
 */
export class Debouncer<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { args: T; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  private closed = false;
  constructor(
    private readonly work: (latest: T) => Promise<void>,
    private readonly delayMs: number,
  ) {
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new Error("Debouncer delay must be a non-negative finite number");
  }
  /**
   * Schedule `args` to run after the debounce window. Returns a promise that
   * resolves when the work completes. Coalesces with any pending call: the
   * `work` callback runs exactly once for the trailing edge of the window
   * and receives the latest args.
   */
  schedule(args: T): Promise<void> {
    if (this.closed) throw new Error("Debouncer is closed");
    if (this.pending) {
      this.pending.args = args;
      return this.pending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    this.pending = { args, promise, resolve, reject };
    this.timer = setTimeout(() => {
      // If close() ran between schedule() and the timer firing, the pending
      // promise was already settled (rejected by run() inside flush()).
      // Don't kick off a second run; it would race the cleanup that follows.
      if (!this.pending) return;
      void this.run().catch(() => {});
    }, this.delayMs);
    return promise;
  }
  /** Wait for any pending work to complete; no-op if none is scheduled. */
  async flush(): Promise<void> {
    if (!this.pending) return;
    clearTimeout(this.timer);
    await this.run();
  }
  /** Flush and stop accepting new schedules. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
  }
  private async run(): Promise<void> {
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      await this.work(pending.args);
      pending.resolve();
    } catch (error) {
      pending.reject(error);
    }
  }
}
