/**
 * M7.3 — monotonic clock primitives.
 *
 * Wall clocks (`Date.now`, `process.uptime`, ISO timestamps) are
 * honest about when something happened relative to the rest of the
 * world — but they are not stable across a Node process: the system
 * clock can step backwards (NTP correction, daylight-savings on a
 * container that resumed from suspend), and `process.uptime()` is
 * reset by every restart.
 *
 * M7.3 requires "monotonic elapsed time within a boot" — i.e. a
 * clock that:
 *
 *   - always advances within a single Node process;
 *   - is comparable across awaits and `setTimeout` ticks;
 *   - has an arbitrary origin (so two processes can compare
 *     `monotonicSince(basisA) < monotonicSince(basisB)` only after
 *     subtracting both from a shared reference);
 *   - never steps backwards inside one process.
 *
 * `process.hrtime.bigint()` is exactly this on every supported
 * runtime (POSIX `clock_gettime(CLOCK_MONOTONIC)` underneath on
 * Linux/macOS, `QueryPerformanceCounter` on Windows). The Node docs
 * explicitly forbid the system clock from moving `hrtime` backwards
 * within one process.
 *
 * The unit conversion (`ns → ms`) drops the sub-ms precision. That
 * is fine: the audit log records integer milliseconds and the M7.3
 * spec only asks for ordering, not nanosecond timestamps.
 *
 * The functions return `bigint` so two monotonic values stay
 * directly comparable even when their plain-number counterparts
 * would overflow `Number.MAX_SAFE_INTEGER` (≈ 9 × 10¹⁵ ms ≈ 285
 * years). `formatMonotonicMs` returns a decimal string for storage
 * in `INTEGER` columns.
 */

let basis: bigint | undefined;

/**
 * Return the monotonic time in milliseconds since an arbitrary
 * process-relative origin. Always advances; never returns a value
 * smaller than a previous call within the same process.
 */
export function monotonicNow(): bigint {
  return process.hrtime.bigint() / 1_000_000n;
}

/**
 * Mark the current monotonic instant as the boot's basis. Subsequent
 * `monotonicSince(basis)` calls return the elapsed ms since this
 * call. Idempotent: subsequent calls reset the basis (intended only
 * for tests that need a stable zero-point).
 *
 * Returns the basis value so callers can persist it.
 */
export function markBootBasis(): bigint {
  basis = monotonicNow();
  return basis;
}

/**
 * Read the boot basis set by `markBootBasis`. Returns `undefined`
 * when the basis has not been marked in this process (callers
 * should treat that as "the boot just started" and mint a new
 * basis rather than waiting on `markBootBasis`).
 */
export function readBootBasis(): bigint | undefined {
  return basis;
}

/**
 * Return the elapsed milliseconds since `basis`. Throws when the
 * delta would be negative (only possible if the caller passed a
 * `basis` from the future, which is a programmer error rather than
 * a clock anomaly).
 */
export function monotonicSince(basisMs: bigint): bigint {
  const delta = monotonicNow() - basisMs;
  if (delta < 0n) {
    throw new RangeError(
      `monotonicSince received a future basis (${basisMs}ms); clocks never run backwards within one process`,
    );
  }
  return delta;
}

/** Render a monotonic-ms `bigint` as a base-10 decimal string for
 *  persistence in INTEGER columns. */
export function formatMonotonicMs(ms: bigint): string {
  return ms.toString(10);
}
