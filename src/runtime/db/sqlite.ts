/**
 * `node:sqlite` driver for the bounded control-state worker.
 *
 * Imported lazily: dev environments without `node:sqlite` (Node < 22.5) only
 * pay the import cost when the driver is actually instantiated. The runtime
 * entrypoint (Node >= 22.12 with the bundled Electron engine) uses this driver;
 * tests and dev shells can substitute the in-memory implementation instead.
 *
 * The driver intentionally does not transform SQL or expand the surface of
 * `Database`: production code targets the same contract as the in-memory
 * implementation, so behaviour stays comparable across drivers.
 */
import { types as utilTypes } from "node:util";
import type { Bindings, Database, Row, Statement, Transaction, Value } from "./types";

interface SqliteStatementRaw {
  run(...params: Value[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: Value[]): Row | undefined;
  all(...params: Value[]): Row[];
}
interface SqliteDatabaseRaw {
  prepare(sql: string): SqliteStatementRaw;
  exec(sql: string): void;
  close(): void;
}
interface SqliteModule { DatabaseSync: new (path: string) => SqliteDatabaseRaw }

class SqliteStatementWrapper implements Statement {
  private finalized = false;
  constructor(private readonly statement: SqliteStatementRaw) {}
  run(...bindings: Bindings): void {
    this.ensureOpen();
    this.statement.run(...bindings);
  }
  first(...bindings: Bindings): Row | undefined {
    this.ensureOpen();
    return this.statement.get(...bindings);
  }
  all(...bindings: Bindings): Row[] {
    this.ensureOpen();
    return this.statement.all(...bindings);
  }
  finalize(): void { this.finalized = true; }
  private ensureOpen() { if (this.finalized) throw new Error("Statement is finalized"); }
}

class SqliteTransaction implements Transaction {
  private done = false;
  commit(): void { /* implicit on fn return; rollback only on throw */ }
  rollback(): void { if (this.done) return; throw new Error("Rollback requested; abort the enclosing transaction body"); }
  finish(): void { this.done = true; }
}

export class SqliteDatabase implements Database {
  private readonly connection: SqliteDatabaseRaw;
  private closed = false;
  private inTransaction = false;
  constructor(filename: string) {
    // Works in both the ESM test runner and the bundled CommonJS runtime.
    const module = process.getBuiltinModule("node:sqlite") as SqliteModule | undefined;
    if (!module?.DatabaseSync) throw new Error("This runtime does not provide node:sqlite");
    this.connection = new module.DatabaseSync(filename);
    // Apply FULL durability and WAL pragmas up-front so a power loss never
    // leaves an "acknowledged" row stranded in WAL-only state.
    this.connection.exec("PRAGMA journal_mode = WAL");
    this.connection.exec("PRAGMA synchronous = FULL");
    this.connection.exec("PRAGMA foreign_keys = ON");
    this.connection.exec("PRAGMA busy_timeout = 5000");
  }
  prepare(sql: string): Statement { return new SqliteStatementWrapper(this.connection.prepare(sql)); }
  transaction<T>(fn: (tx: Transaction) => T): T {
    if (this.closed) throw new Error("Database is closed");
    if (this.inTransaction) throw new Error("Nested transactions are not allowed");
    if (utilTypes.isAsyncFunction(fn)) throw new Error("Transaction bodies must be synchronous");
    this.connection.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    const txHandle = new SqliteTransaction();
    try {
      const result = fn(txHandle);
      if (result && typeof (result as { then?: unknown }).then === "function") {
        // Do not leave a rejected promise unobserved, or commit before it settles.
        void Promise.resolve(result).catch(() => {});
        throw new Error("Transaction bodies must be synchronous");
      }
      this.connection.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.connection.exec("ROLLBACK"); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], "Transaction and rollback failed"); }
      throw error;
    } finally {
      txHandle.finish();
      this.inTransaction = false;
    }
  }
  exclusive<T>(fn: () => T): T { return fn(); }
  lastInsertRowid(): number {
    const row = this.connection.prepare("SELECT last_insert_rowid() AS id").get();
    return Number((row as { id: number | bigint }).id);
  }
  changes(): number {
    const row = this.connection.prepare("SELECT changes() AS value").get();
    return Number((row as { value: number }).value);
  }
  flush(): void { this.connection.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
  close(): void { if (this.closed) return; this.connection.close(); this.closed = true; }
}

/** Detect whether the running Node provides `node:sqlite`. */
export function hasSqliteBuiltin(): boolean {
  try { return Boolean(process.getBuiltinModule("node:sqlite")?.DatabaseSync); }
  catch { return false; }
}
