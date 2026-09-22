/** Coalesces pending values; active writes always finish in submission order. */
export class Debouncer<T> {
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: { args: T; promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void };
  private active?: Promise<void>;
  private failure?: { error: unknown };
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly work: (latest: T) => Promise<void>, private readonly delayMs: number) {
    if (!Number.isFinite(delayMs) || delayMs < 0)
      throw new Error("Debouncer delay must be a non-negative finite number");
  }
  /** Resolves only after this value, or a newer coalesced value, is written. */
  schedule(args: T): Promise<void> {
    if (this.closed) throw new Error("Debouncer is closed");
    if (this.pending) {
      this.pending.args = args;
      return this.pending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    // flush/close also observe failures, even if a caller attaches its handler later.
    void promise.catch(() => {});
    this.pending = { args, promise, resolve, reject };
    this.timer = setTimeout(() => { this.timer = undefined; this.start(); }, this.delayMs);
    return promise;
  }
  private start() {
    if (this.active || !this.pending) return;
    const pending = this.pending;
    this.pending = undefined;
    clearTimeout(this.timer); this.timer = undefined;
    this.active = Promise.resolve().then(() => this.work(pending.args)).then(() => {
      this.failure = undefined;
      pending.resolve();
    }, error => {
      this.failure = { error };
      pending.reject(error);
    }).finally(() => {
      this.active = undefined;
      if (this.pending && !this.timer) this.start();
    });
  }
  /** Drain queued AND active writes; an unrecovered write failure remains observable. */
  async flush(): Promise<void> {
    while (this.active || this.pending) {
      clearTimeout(this.timer); this.timer = undefined;
      this.start();
      await this.active;
    }
    if (this.failure) throw this.failure.error;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      this.closing = this.flush();
    }
    return this.closing;
  }
}
