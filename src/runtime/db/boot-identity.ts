/**
 * M7.3 — boot identity.
 *
 * Every runtime process mints a "boot identity" the moment it opens
 * a SQLite store. The identity is persisted to the `meta` table so a
 * second process attempting to read pending occurrences from the
 * same file can recognise which rows it actually owns.
 *
 * The M7.3 spec calls this out:
 *
 *   "Monotonic elapsed time within a boot; record wall time + boot
 *    identity across restart."
 *
 * Concretely, every dispatched occurrence row carries a `boot_id`
 * that records which Node process was running when the dispatcher
 * flipped `state: "pending" → "dispatched"`. A subsequent boot finds
 * pending rows whose `boot_id !== currentBootId`, treats them as
 * stranded (the previous process died before they moved out of
 * `pending`), and reconciles them to `state: "unavailable"`.
 *
 * Persistence strategy:
 *
 *   - On `mintBootIdentity`, insert `meta` row
 *     `dispatcher-boot:<bootId>` whose `value` is a JSON object
 *     `{ bootedAtIso, monotonicBasisMs, pid, nodeVersion }`.
 *   - `readActiveBootIdentity` scans every `dispatcher-boot:*`
 *     key and returns the row whose `pid === process.pid`. If the
 *     process was reused across restarts (containers on Linux,
 *     dev shells), the scan misses and the next call mints a new
 *     identity.
 *   - `purgeStaleBootIdentities` removes rows whose `pid` does not
 *     match the current process; intended for the start of each
 *     boot to keep the meta table bounded.
 *
 * Memoisation: `mintBootIdentity` returns the same identity on
 * repeat calls (the runtime calls it once during open + once per
 * dispatch pass). Tests can call `__resetBootIdentityForTest` to
 * drop the memo.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "./types";
import { monotonicNow } from "./monotonic";

export interface BootIdentity {
  readonly bootId: string;
  readonly bootedAtIso: string;
  readonly monotonicBasisMs: string; // base-10 string for storage in JSON
  readonly pid: number;
  readonly nodeVersion: string;
}

const META_KEY_PREFIX = "dispatcher-boot:";
const META_KEY_RE = /^dispatcher-boot:(.+)$/;

/** Memoised identity for the current process — `null` until minted. */
let memo: BootIdentity | null = null;

/** Generate a new boot identity. UUIDv4 + process pid is enough
 *  entropy for "is this the same process that dispatched me" tests. */
function generateIdentity(): BootIdentity {
  return {
    bootId: randomUUID(),
    bootedAtIso: new Date().toISOString(),
    // Use the absolute monotonic millisecond value (not the
    // post-basis delta) as the basis reference persisted to
    // `meta`. Reading the value back is only useful for audit
    // ("this boot's monotonic basis was X ms"); the relative
    // measurement is always `monotonicNow() - basis`.
    monotonicBasisMs: monotonicNow().toString(10),
    pid: process.pid,
    nodeVersion: process.version,
  };
}

/** Mint (or re-use) this process's boot identity and persist it to
 *  `meta`. Repeated calls return the memoised identity. */
export function mintBootIdentity(db: Database): BootIdentity {
  if (memo) return memo;
  const id = generateIdentity();
  db.prepare(
    "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
  ).run(`${META_KEY_PREFIX}${id.bootId}`, JSON.stringify({
    bootedAtIso: id.bootedAtIso,
    monotonicBasisMs: id.monotonicBasisMs,
    pid: id.pid,
    nodeVersion: id.nodeVersion,
  }));
  memo = id;
  return id;
}

/** Look up the boot identity that owns this process. Scans every
 *  `dispatcher-boot:*` row and returns the one whose `pid` matches
 *  the running process. Returns `undefined` when no row matches
 *  (the typical case for a fresh boot — the caller should mint a
 *  new identity).
 *
 *  The range-scan (`key >= prefix AND key < upper-bound`) keeps the
 *  query portable to the in-memory test driver, which supports
 *  comparison operators but not `LIKE`. SQLite's bundled driver
 *  understands the same range scan and uses the meta key index. */
export function readActiveBootIdentity(db: Database): BootIdentity | undefined {
  const rows = readBootIdentityRows(db);
  for (const row of rows) {
    const match = row.key.match(META_KEY_RE);
    if (!match) continue;
    let parsed: Partial<BootIdentity> | null;
    try { parsed = JSON.parse(row.value) as Partial<BootIdentity>; }
    catch { continue; }
    if (parsed.pid !== process.pid) continue;
    return {
      bootId: match[1],
      bootedAtIso: String(parsed.bootedAtIso ?? ""),
      monotonicBasisMs: String(parsed.monotonicBasisMs ?? "0"),
      pid: Number(parsed.pid ?? 0),
      nodeVersion: String(parsed.nodeVersion ?? ""),
    };
  }
  return undefined;
}

/** Remove every boot-identity row whose `pid` does not match the
 *  current process. Invoked once per boot during
 *  `RuntimeWorkspace.open`. Returns the number of rows deleted so
 *  tests + audit can assert the seam ran. */
export function purgeStaleBootIdentities(db: Database): number {
  const rows = readBootIdentityRows(db);
  let removed = 0;
  const del = db.prepare("DELETE FROM meta WHERE key = ?");
  for (const row of rows) {
    let parsed: Partial<BootIdentity> | null;
    try { parsed = JSON.parse(row.value) as Partial<BootIdentity>; }
    catch { del.run(row.key); removed += 1; continue; }
    if (parsed.pid !== process.pid) {
      del.run(row.key);
      removed += 1;
    }
  }
  return removed;
}

/** Range-scan the `meta` table for boot-identity rows. The prefix
 *  is `dispatcher-boot:`; the upper-bound is `dispatcher-boot;` (a
 *  character that sorts immediately after `:`) so the query
 *  matches every UUID-suffixed key. */
function readBootIdentityRows(db: Database): Array<{ key: string; value: string }> {
  return db
    .prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?")
    .all(META_KEY_PREFIX, META_KEY_PREFIX.slice(0, -1) + ";") as Array<{ key: string; value: string }>;
}

/** Read the memoised identity without falling back to minting.
 *  Returns `undefined` when `mintBootIdentity` has not yet run in
 *  this process. */
export function readMemoisedBootIdentity(): BootIdentity | undefined {
  return memo ?? undefined;
}

/** Test-only seam — drops the process memo so the next
 *  `mintBootIdentity` call mints a fresh identity. Never called
 *  from production code. */
export function __resetBootIdentityForTest(): void {
  memo = null;
}
