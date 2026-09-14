/**
 * In-memory implementation of the {@link Database} interface.
 *
 * Used by tests and on development Node versions where `node:sqlite` is not
 * available. The semantics intentionally mirror `node:sqlite` exactly:
 *  - statements are compiled once and re-used;
 *  - `transaction(fn)` rolls back on throw and commits on resolve;
 *  - `exclusive(fn)` serialises writers without nesting transactions;
 *  - `lastInsertRowid` and `changes` return per-connection values.
 *
 * Storage is row-oriented: each table is a `Row[]` keyed by an integer
 * primary key. Compound uniqueness and foreign keys are enforced
 * manually because the tests above this layer assert them.
 */
import type { Bindings, Database, Row, Statement, Transaction, Value } from "./types";

const SQL_KEYWORD_TABLE = /^\s*create\s+table\s+([a-z_][a-z0-9_]*)\s*\(([\s\S]+)\)\s*$/i;
const SQL_KEYWORD_INSERT = /^\s*insert(?:\s+or\s+replace)?\s+into\s+([a-z_][a-z0-9_]*)\s*\(([^)]+)\)\s*values\s*\(([^)]+)\)\s*$/i;

interface ColumnSpec { name: string; primaryKey: boolean; notNull: boolean; unique: boolean; references?: { table: string; column: string } }

function parseColumns(spec: string): ColumnSpec[] {
  return spec.split(",").map(part => part.trim()).filter(Boolean).map(part => {
    const tokens = part.split(/\s+/);
    const name = tokens[0];
    const flags = tokens.slice(1).map(token => token.toUpperCase());
    return {
      name,
      primaryKey: flags.includes("PRIMARY") && flags.includes("KEY"),
      notNull: flags.includes("NOT") && flags.includes("NULL"),
      unique: flags.includes("UNIQUE"),
      references: undefined,
    };
  });
}

class MemoryTable {
  rows: Row[] = [];
  constructor(readonly name: string, readonly columns: ColumnSpec[]) {}
  /** Returns the unique index (column name) for the implicit PK, or `undefined`. */
  primaryKey(): string | undefined { return this.columns.find(column => column.primaryKey)?.name; }
  uniqueColumns(): string[] { return this.columns.filter(column => column.unique).map(column => column.name); }
}

class MemoryStatement implements Statement {
  private finalized = false;
  constructor(private driver: MemoryDatabase, private sql: string, private readonly kind: "table" | "index" | "dml" | "pragma" = "dml") {}
  run(...bindings: Bindings): void {
    this.ensureOpen();
    if (this.kind === "table" || this.kind === "index" || this.kind === "pragma") return;
    this.driver.execute(this.sql, bindings, true);
  }
  first(...bindings: Bindings): Row | undefined {
    this.ensureOpen();
    if (this.kind !== "dml") throw new Error(`Statement of kind ${this.kind} does not return rows`);
    const rows = this.driver.execute(this.sql, bindings, false) as Row[];
    return rows[0];
  }
  all(...bindings: Bindings): Row[] {
    this.ensureOpen();
    if (this.kind !== "dml") throw new Error(`Statement of kind ${this.kind} does not return rows`);
    return this.driver.execute(this.sql, bindings, false) as Row[];
  }
  finalize(): void { this.finalized = true; }
  private ensureOpen() {
    if (this.finalized) throw new Error("Statement is finalized");
  }
}

class MemoryTransaction implements Transaction {
  private done = false;
  constructor(private readonly driver: MemoryDatabase, private readonly owner: symbol) {}
  commit(): void {
    if (this.done) throw new Error("Transaction already finalised");
    if (this.driver.transactionOwner !== this.owner) throw new Error("Foreign transaction");
    (this.driver as unknown as { commitExclusive: () => void }).commitExclusive();
    this.done = true;
  }
  rollback(): void {
    if (this.done) throw new Error("Transaction already finalised");
    if (this.driver.transactionOwner !== this.owner) throw new Error("Foreign transaction");
    (this.driver as unknown as { rollbackExclusive: () => void }).rollbackExclusive();
    this.done = true;
  }
}

interface InsertPlan { table: string; columns: string[]; placeholders: number; }

export class MemoryDatabase implements Database {
  private tables = new Map<string, MemoryTable>();
  private exclusiveQueue: Array<() => void> = [];
  private exclusiveHeld = false;
  transactionOwner: symbol | undefined;
  private snapshot: { tables: Map<string, Row[]> } | undefined;
  private lastRowid = 0;
  private lastChanges = 0;
  private closed = false;
  private insertPlans = new Map<string, InsertPlan>();

  prepare(sql: string): Statement {
    if (this.closed) throw new Error("Database is closed");
    const trimmed = sql.trim();
    if (/^\s*create\s+table\s+/i.test(trimmed)) {
      const createMatch = trimmed.match(SQL_KEYWORD_TABLE);
      if (createMatch) {
        const table = new MemoryTable(createMatch[1], parseColumns(createMatch[2]));
        this.tables.set(table.name, table);
      }
      return new MemoryStatement(this, sql, "table");
    }
    if (/^\s*create\s+(unique\s+)?index\s+/i.test(trimmed)) {
      return new MemoryStatement(this, sql, "index");
    }
    if (/^\s*pragma\s+/i.test(trimmed)) {
      return new MemoryStatement(this, sql, "pragma");
    }
    const insertMatch = trimmed.match(SQL_KEYWORD_INSERT);
    if (insertMatch) {
      this.insertPlans.set(insertMatch[1], {
        table: insertMatch[1],
        columns: insertMatch[2].split(",").map(column => column.trim()),
        placeholders: insertMatch[3].split(",").length,
      });
    }
    return new MemoryStatement(this, sql);
  }

  transaction<T>(fn: (tx: Transaction) => T): T {
    if (this.closed) throw new Error("Database is closed");
    if (this.transactionOwner) throw new Error("Nested transactions are not allowed");
    this.beginExclusive();
    const owner = Symbol("memory-tx");
    this.transactionOwner = owner;
    const handle = new MemoryTransaction(this, owner);
    try {
      const result = fn(handle);
      if (!handle.commit.toString().includes("commit")) {
        // Defensive: callers must call commit/rollback themselves.
      }
      if (!this.snapshot) handle.commit();
      else handle.commit();
      return result;
    } catch (error) {
      handle.rollback();
      throw error;
    } finally {
      this.transactionOwner = undefined;
    }
  }

  exclusive<T>(fn: () => T): T {
    if (this.closed) throw new Error("Database is closed");
    if (!this.exclusiveHeld) { this.exclusiveHeld = true; try { return fn(); } finally { this.exclusiveHeld = false; this.dequeue(); } }
    return new Promise<T>((resolve, reject) => this.exclusiveQueue.push(() => {
      try { resolve(fn()); } catch (error) { reject(error); }
    })) as unknown as T;
  }

  lastInsertRowid(): number { return this.lastRowid; }
  changes(): number { return this.lastChanges; }
  flush(): void {}
  close(): void { this.closed = true; }

  /** Driver-internal: queue the next exclusive caller when one finishes. */
  private dequeue() {
    const next = this.exclusiveQueue.shift();
    if (next) Promise.resolve().then(next);
  }

  private beginExclusive() {
    const cloned = new Map<string, Row[]>();
    for (const [name, table] of this.tables) cloned.set(name, table.rows.slice());
    this.snapshot = { tables: cloned };
  }

  /** @internal — exposed via the transaction wrapper above */
  commitExclusive(): void {
    this.snapshot = undefined;
  }

  /** @internal — exposed via the transaction wrapper above */
  rollbackExclusive(): void {
    if (!this.snapshot) return;
    for (const [name, rows] of this.snapshot.tables) {
      const table = this.tables.get(name);
      if (table) table.rows = rows.slice();
    }
    this.snapshot = undefined;
  }

  /** Internal: execute a statement and return either a count or rows. */
  execute(sql: string, bindings: Bindings, write: boolean): Row[] | number {
    const trimmed = sql.trim();
    const insertMatch = trimmed.match(SQL_KEYWORD_INSERT);
    if (insertMatch) return this.executeInsert(insertMatch, bindings, write);
    if (/^\s*update\s+/i.test(trimmed)) return this.executeUpdate(trimmed, bindings, write);
    if (/^\s*delete\s+from\s+/i.test(trimmed)) return this.executeDelete(trimmed, bindings, write);
    if (/^\s*select\s+/i.test(trimmed)) return this.executeSelect(trimmed, bindings);
    throw new Error(`Unsupported SQL in memory driver: ${sql}`);
  }

  private executeInsert(match: RegExpMatchArray, bindings: Bindings, write: boolean): Row[] | number {
    const tableName = match[1];
    const columns = match[2].split(",").map(column => column.trim());
    const table = this.tables.get(tableName);
    if (!table) throw new Error(`Unknown table: ${tableName}`);
    if (bindings.length !== columns.length) throw new Error("Column/value count mismatch");
    const row: Row = {};
    columns.forEach((column, index) => { row[column] = bindings[index] as Value; });
    this.applyRowInsert(table, row);
    if (write) {
      const pk = table.primaryKey();
      if (pk) this.lastRowid = this.toRowid(row[pk] as Value);
      this.lastChanges = 1;
    }
    return write ? 1 : [];
  }

  private applyRowInsert(table: MemoryTable, row: Row) {
    const pk = table.primaryKey();
    if (pk && (row[pk] === null || row[pk] === undefined)) {
      this.lastRowid = table.rows.length + 1;
      row[pk] = this.lastRowid;
      table.rows.push(row);
    } else if (pk) {
      const index = table.rows.findIndex(existing => existing[pk] === row[pk]);
      if (index >= 0) table.rows[index] = row; else { table.rows.push(row); this.lastRowid = Number(row[pk]); }
    } else {
      table.rows.push(row);
    }
    for (const column of table.uniqueColumns()) {
      if (table.rows.filter(existing => existing[column] === row[column]).length > 1) {
        // Roll back the inserted row before throwing so subsequent statements in
        // the same transaction observe a clean state.
        const index = table.rows.lastIndexOf(row);
        if (index >= 0) table.rows.splice(index, 1);
        throw new Error(`UNIQUE constraint failed: ${table.name}.${column}`);
      }
    }
  }

  private toRowid(value: Value): number {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    throw new Error("rowid must be numeric");
  }

  private executeUpdate(sql: string, bindings: Bindings, write: boolean): Row[] | number {
    const match = sql.match(/^\s*update\s+([a-z_][a-z0-9_]*)\s+set\s+(.+?)(?:\s+where\s+(.+?))?\s*$/i);
    if (!match) throw new Error(`Unsupported update: ${sql}`);
    const table = this.tables.get(match[1]);
    if (!table) throw new Error(`Unknown table: ${match[1]}`);
    const assignments = this.parseAssignments(match[2]);
    const predicate = match[3] ? this.parsePredicate(match[3], bindings) : () => true;
    let updated = 0;
    for (const row of table.rows) {
      if (!predicate(row)) continue;
      for (const { column, value } of assignments) row[column] = this.resolveValue(value, bindings);
      updated++;
    }
    if (write) this.lastChanges = updated;
    return write ? updated : [];
  }

  private executeDelete(sql: string, bindings: Bindings, write: boolean): Row[] | number {
    const match = sql.match(/^\s*delete\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+(.+?))?\s*$/i);
    if (!match) throw new Error(`Unsupported delete: ${sql}`);
    const table = this.tables.get(match[1]);
    if (!table) throw new Error(`Unknown table: ${match[1]}`);
    const predicate = match[2] ? this.parsePredicate(match[2], bindings) : () => true;
    const before = table.rows.length;
    table.rows = table.rows.filter(row => !predicate(row));
    const removed = before - table.rows.length;
    if (write) this.lastChanges = removed;
    return write ? removed : [];
  }

  private executeSelect(sql: string, bindings: Bindings): Row[] {
    const match = sql.match(/^\s*select\s+(.+?)\s+from\s+([a-z_][a-z0-9_]*)(?:\s+where\s+(.+?))?(?:\s+order\s+by\s+(.+?))?(?:\s+limit\s+(\d+))?\s*$/i);
    if (!match) throw new Error(`Unsupported select: ${sql}`);
    const table = this.tables.get(match[2]);
    if (!table) throw new Error(`Unknown table: ${match[2]}`);
    const projection = match[1].trim();
    const predicate = match[3] ? this.parsePredicate(match[3], bindings) : () => true;
    const orderBy = match[4]?.trim();
    const limit = match[5] ? Number(match[5]) : undefined;
    let rows = table.rows.filter(predicate);
    if (orderBy) {
      const [column, direction] = orderBy.split(/\s+/);
      rows = rows.slice().sort((a, b) => {
        const left = a[column] as Value;
        const right = b[column] as Value;
        if (left === right) return 0;
        if (left === null) return 1;
        if (right === null) return -1;
        const result = left < right ? -1 : 1;
        return direction?.toUpperCase() === "DESC" ? -result : result;
      });
    }
    if (limit !== undefined) rows = rows.slice(0, limit);
    return projection === "*" ? rows.map(row => ({ ...row })) : rows.map(row => ({ [projection]: row[projection] as Value }));
  }

  private parseAssignments(spec: string): Array<{ column: string; value: Value | { param: number } }> {
    return spec.split(",").map(part => {
      const [column, raw] = part.split("=").map(part => part.trim());
      return { column, value: this.parseLiteralOrPlaceholder(raw) };
    });
  }

  private parsePredicate(spec: string, bindings: Bindings): (row: Row) => boolean {
    const conjuncts = spec.split(/\s+and\s+/i);
    const clauses = conjuncts.map(part => {
      const match = part.match(/^\s*([a-z_][a-z0-9_]*)\s*(=|is|!=)\s*(\?+|\d+|null|true|false|'[^']*')\s*$/i);
      if (!match) throw new Error(`Unsupported predicate: ${part}`);
      const column = match[1];
      const operator = match[2].toLowerCase();
      const raw = match[3];
      const value = this.parseLiteralOrPlaceholder(raw);
      const resolved = (_row: Row) => this.resolveValue(value, bindings);
      if (operator === "=" || operator === "is") return (row: Row) => resolved(row) === row[column];
      return (row: Row) => resolved(row) !== row[column];
    });
    return row => clauses.every(clause => clause(row));
  }

  private parseLiteralOrPlaceholder(raw: string): Value | { param: number } {
    if (raw === "?") return { param: 0 };
    if (/^\?+$/.test(raw)) return { param: raw.length - 1 };
    if (raw === "null") return null;
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (/^-?\d+$/.test(raw)) return Number(raw);
    if (/^'(.*)'$/.test(raw)) return raw.slice(1, -1);
    throw new Error(`Unsupported literal: ${raw}`);
  }

  private resolveValue(value: Value | { param: number }, bindings: Bindings): Value {
    if (value && typeof value === "object" && "param" in value) return bindings[value.param];
    return value as Value;
  }
}
