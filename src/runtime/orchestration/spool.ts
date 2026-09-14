/**
 * M3b.3 — in-memory spool guard.
 *
 * `Spool.reserve(bytes)` accepts a sequence of bytes into the spool up
 * to a quota; the commit is durable only when the orchestrator calls
 * `Spool.commit(seq)` after writing the corresponding observation event.
 * Past the quota, `reserve` raises `quota-exhausted` so the orchestrator
 * can apply backpressure and refuse further provider output.
 *
 * The interface is intentionally the same one a SQLite-backed
 * implementation would expose in Increment 4+. The current in-memory
 * `Map<seq, Uint8Array>` lets tests exercise the commit/abort flow
 * without a database.
 */
import { AppError } from "../../shared/errors";

export interface SpoolOptions {
  /** Maximum queued bytes before `reserve` raises. Default 8 MiB. */
  readonly quotaBytes?: number;
}

export interface ReserveOk { readonly ok: true; readonly seq: number; readonly totalBytes: number }
export interface ReserveFail {
  readonly ok: false;
  readonly reason: "quota-exhausted";
  readonly totalBytes: number;
  readonly attempted: number;
}
export type ReserveOutcome = ReserveOk | ReserveFail;

export class SpoolGuard {
  private readonly buffers = new Map<number, Uint8Array>();
  private readonly reserveSizes = new Map<number, number>();
  private readonly quotaBytes: number;
  private nextSeq = 1;
  private totalBytes = 0;

  constructor(options: SpoolOptions = {}) {
    this.quotaBytes = options.quotaBytes ?? 8 * 1024 * 1024;
  }

  /** Bytes currently held in the spool (not yet committed or aborted). */
  get queued(): number { return this.totalBytes; }

  /**
   * Reserve space for `bytes`. Returns the sequence number the caller
   * should pass to `commit` / `abort`. Bytes are *not* copied here — the
   * caller passes them to `commit` once the observation has been
   * written durably.
   */
  reserve(bytes: number): ReserveOutcome {
    if (bytes < 0) throw new AppError("INVALID_REQUEST", `reserve: negative byte count ${bytes}`);
    if (this.totalBytes + bytes > this.quotaBytes) {
      return { ok: false, reason: "quota-exhausted", totalBytes: this.totalBytes, attempted: bytes };
    }
    this.totalBytes += bytes;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.reserveSizes.set(seq, bytes);
    return { ok: true, seq, totalBytes: this.totalBytes };
  }

  /**
   * Commit `bytes` under `seq`. The bytes are *copied* into the spool.
   * The reserved quota has already been debited at reserve time, so this
   * call only stores the buffer for replay — it does not change the
   * running total. After commit, the slot is durable and may be replayed
   * on rehydrate.
   */
  commit(seq: number, bytes: Uint8Array): void {
    if (this.buffers.has(seq)) throw new AppError("CONFLICT", `Spool seq ${seq} is already committed`);
    if (bytes.byteLength !== this.reserveSizes.get(seq))
      throw new AppError("INVALID_REQUEST", `Spool seq ${seq}: committed size ${bytes.byteLength} differs from reserved size ${this.reserveSizes.get(seq) ?? "?"}`);
    this.buffers.set(seq, bytes);
    this.reserveSizes.delete(seq);
  }

  /**
   * Abort a previously-reserved seq. Removes the reservation from the
   * queue and refunds the bytes to the quota. No-op if the seq was
   * already committed (in which case there is nothing to abort) or was
   * never reserved.
   */
  abort(seq: number): void {
    if (this.buffers.has(seq)) return; // committed; nothing to abort
    const reserved = this.reserveSizes.get(seq);
    if (reserved === undefined) return;
    this.reserveSizes.delete(seq);
    this.totalBytes = Math.max(0, this.totalBytes - reserved);
  }

  /** Total committed bytes. */
  committedBytes(): number {
    let total = 0;
    for (const buf of this.buffers.values()) total += buf.byteLength;
    return total;
  }

  /** Replay committed bytes in seq order. Used by Increment 4 rehydrate. */
  *replay(): IterableIterator<{ seq: number; bytes: Uint8Array }> {
    const seqs = [...this.buffers.keys()].sort((a, b) => a - b);
    for (const seq of seqs) {
      const bytes = this.buffers.get(seq);
      if (bytes) yield { seq, bytes };
    }
  }
}