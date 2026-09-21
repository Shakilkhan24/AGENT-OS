/**
 * M2.1 driver-agnostic database contract for the bounded control-state worker.
 *
 * Two implementations back this surface:
 *  - `node:sqlite` (production runtime, Node >= 22.5 with the bundled engine)
 *  - an in-memory fake used by tests and on development Node versions where
 *    `node:sqlite` is not available
 *
 * The runtime never issues SQL directly: every mutation goes through
 * `transaction(fn)` so that state rows, audit events and dispatch intents
 * commit together. Filesystem/process effects stay outside the transaction.
 *
 * This surface is intentionally small. Adding capabilities beyond these
 * primitives is a separate decision (backup, replication, secondary indexes).
 */

import type { z } from "zod";

/** Row shape returned from the driver; callers re-validate with Zod. */
export type Row = Record<string, unknown>;

/** A single SQL parameter value or a `Uint8Array` for binary columns. */
export type Value = string | number | bigint | boolean | null | Uint8Array;

/** Statement binding parameters in declaration order. */
export type Bindings = ReadonlyArray<Value>;

/** Statement returned by `prepare`; must support repeated execution. */
export interface Statement {
  /** Bind parameters, execute, then reset bindings so the statement is reusable. */
  run(...bindings: Bindings): void;
  /** Return the first row or `undefined`. */
  first(...bindings: Bindings): Row | undefined;
  /** Return every row. The driver chooses between streaming and array materialisation. */
  all(...bindings: Bindings): Row[];
  /** Release any native resources held by this statement. */
  finalize(): void;
}

/** Driver-level transaction handle. The body runs synchronously. */
export interface Transaction {
  /** Commit the in-flight transaction. Throws on constraint/syntax failures. */
  commit(): void;
  /** Roll the transaction back; subsequent calls on this handle throw. */
  rollback(): void;
}

/** Capabilities the bounded worker needs from the driver. */
export interface Database {
  /** Prepare a statement. The driver may cache the compiled plan. */
  prepare(sql: string): Statement;
  /** Run a body in a transaction; commit on resolve, rollback on throw. */
  transaction<T>(fn: (tx: Transaction) => T): T;
  /** Acquire an exclusive lock; the body must complete before any other writer runs. */
  exclusive<T>(fn: () => T): T;
  /** Last inserted rowid for the current connection (driver-specific). */
  lastInsertRowid(): number | bigint;
  /** Total number of rows changed by the most recent statement. */
  changes(): number;
  /** Force any pending writes to durable storage. */
  flush(): void;
  /** Close the underlying connection. After `close`, every call throws. */
  close(): void;
  /**
   * Optional: run one or more SQL statements with no bindings.
   * Used for migration DDL (`ALTER TABLE …`) which the
   * prepared-statement path rejects because the bindings API expects
   * `?` placeholders. Tests using the in-memory driver leave this
   * undefined (its driver starts fresh with the latest schema so
   * migration isn't needed). Production SQLite exposes it via the
   * bundled `node:sqlite` native `exec`.
   */
  exec?(sql: string): void;
}

/** Strongly-typed wrapper around a row + a Zod schema that validates it. */
export type TypedRowParser<S extends z.ZodTypeAny> = (row: Row) => z.infer<S>;
export const typedRowParser = <S extends z.ZodTypeAny>(schema: S): TypedRowParser<S> => row => schema.parse(row);
