import { AppError } from "../shared/errors";

/** FIFO, bounded and cancellable while waiting; a running task owns its cancellation. */
export class Mutex {
  private active = false;
  private queue: Array<() => void> = [];
  constructor(private limit = 256) {}
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new AppError("CANCELLED", "Operation cancelled");
    if (this.active) {
      if (this.queue.length >= this.limit)
        throw new AppError("BUSY", "Operation queue is full", {
          retryable: true,
        });
      await new Promise<void>((resolve, reject) => {
        const proceed = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          this.queue = this.queue.filter((item) => item !== proceed);
          reject(new AppError("CANCELLED", "Operation cancelled while queued"));
        };
        this.queue.push(proceed);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } else this.active = true;
    try {
      if (signal?.aborted)
        throw new AppError("CANCELLED", "Operation cancelled");
      return await operation();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active = false;
    }
  }
}
