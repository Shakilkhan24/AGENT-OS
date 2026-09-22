/**
 * M2.1 bounded database worker.
 *
 * One worker owns the database connection. Callers submit work via
 * `transaction(...)` or `query(...)`; both return promises that resolve
 * once the worker has scheduled and run the body. The worker serialises
 * writes through a single in-process queue so SQLite's exclusive-lock
 * semantics are never contested from inside the runtime.
 *
 * The worker never executes filesystem/process effects; those happen in the
 * caller *after* the transactional commit completes. This keeps the
 * "state + event + dispatch intent commit together" rule explicit and
 * testable.
 *
 * The worker does not manage transactions that span external resources; if a
 * caller throws inside `transaction`, the driver rolls back and the worker
 * surfaces the rejection to the original submitter.
 */
import { z } from "zod";
import type { Database, Statement, Transaction } from "./types";

export interface DbWorkerOptions {
  /** Driver instance; ownership transfers to the worker. */
  driver: Database;
  /** Maximum concurrent queries in flight; the rest queue. */
  concurrency?: number;
}

interface Pending<T> {
  readonly task: () => Promise<T> | T;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * Tiny queue with at-most-N concurrent runners. The pool keeps CPU usage
 * predictable for callers that fan out (e.g. terminal inspection during a
 * transactional update).
 */
export class DbWorker {
  private readonly driver: Database;
  private readonly concurrency: number;
  private running = 0;
  private queue: Pending<unknown>[] = [];
  private closed = false;
  constructor(options: DbWorkerOptions) {
    if (options.concurrency !== undefined && (!Number.isInteger(options.concurrency) || options.concurrency < 1))
      throw new Error("concurrency must be a positive integer");
    this.driver = options.driver;
    this.concurrency = options.concurrency ?? 4;
  }
  /** Execute a read or write that does not need a transactional boundary. */
  query<T>(task: () => Promise<T> | T): Promise<T> { return this.submit(task); }
  /**
   * Run `body` inside a transaction. The body is responsible for `commit`
   * and `rollback`; throwing rolls back automatically. The body must be
   * synchronous with respect to the driver — `await`ing other DB workers
   * from inside the body is forbidden and would deadlock.
   */
  transaction<T>(body: (tx: Transaction) => T): Promise<T> {
    return this.submit(() => this.driver.transaction(body));
  }
  /**
   * Take an exclusive lock outside any transaction. Use this to wrap a
   * "read state, then write state" sequence atomically without nesting
   * transactions.
   */
  exclusive<T>(task: () => Promise<T> | T): Promise<T> { return this.submit(() => this.driver.exclusive(task)); }
  /** Force the driver to flush its WAL/buffers. */
  flush(): Promise<void> { return this.submit(() => { this.driver.flush(); }); }
  /** Release the driver. In-flight work completes; new submissions reject. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    while (this.running > 0 || this.queue.length > 0)
      await new Promise(resolve => setTimeout(resolve, 1));
    this.driver.close();
  }
  private submit<T>(task: () => Promise<T> | T): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Database worker is closed"));
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve: resolve as (value: unknown) => void, reject });
      this.pump();
    });
  }
  private pump() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.running++;
      Promise.resolve()
        .then(next.task)
        .then(value => { next.resolve(value); this.running--; this.pump(); })
        .catch(error => { next.reject(error); this.running--; this.pump(); });
    }
  }
}

/**
 * Convenience: validate that the prepared statement contract is preserved by
 * the driver. The runtime never issues raw SQL through `Database`; this is a
 * smoke check used by tests to assert driver parity.
 */
export function smokeDriver(driver: Database) {
  const insert = driver.prepare("INSERT INTO smoke (name) VALUES (?)");
  insert.run("alpha");
  insert.run("beta");
  const all = driver.prepare("SELECT name FROM smoke ORDER BY name ASC").all();
  if (all.length !== 2 || (all[0] as { name: string }).name !== "alpha")
    throw new Error("driver did not return rows in expected order");
}

/** Zod helper for callers that need a typed view of a row. */
export const typedRow = <S extends z.ZodTypeAny>(schema: S) => (row: unknown): z.infer<S> => schema.parse(row);

/** Re-exported for typed callers that want to declare their own statement. */
export type { Statement, Transaction };
