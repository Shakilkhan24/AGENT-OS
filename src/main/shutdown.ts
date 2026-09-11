/**
 * Shutdown flush watchdog.
 *
 * The Electron `will-quit` handler awaits a debounced flush of state.json
 * and the event journal. A hung fsync (full disk, wedged I/O) would
 * otherwise hang the whole shutdown — so we race the close against a
 * timeout. On timeout we log and force-exit; state already on disk is
 * preserved, only the last in-flight debounced write may be lost. That's
 * the same guarantee the renderer sees in normal operation.
 *
 * Pure helper — extracted so the timeout + force-exit behaviour is unit
 * testable without spinning up Electron.
 */
import { log } from "./logging";

export interface ShutdownWatchdog {
  /** Cancel the watchdog (call when close() resolves normally). */
  cancel(): void;
  /** Resolves when the close completes or the watchdog trips. */
  done: Promise<"completed" | "timed-out">;
}

export interface ShutdownWatchdogOptions {
  /** How long to wait before forcing exit. */
  budgetMs: number;
  /** What to call on timeout (e.g. `app.exit(1)`). */
  onTimeout: () => void;
  /** Where to log structured shutdown events. Defaults to the global logger. */
  log?: (entry: Parameters<typeof log>[0]) => void;
}

export function runWithWatchdog(
  work: () => Promise<void>,
  options: ShutdownWatchdogOptions,
): ShutdownWatchdog {
  let settled = false;
  let resolveDone!: (result: "completed" | "timed-out") => void;
  const done = new Promise<"completed" | "timed-out">((resolve) => {
    resolveDone = resolve;
  });
  const emit = options.log ?? log;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    emit({
      level: "error",
      source: "application",
      event: "shutdown-flush-timeout",
      fields: { budgetMs: options.budgetMs },
    });
    try { options.onTimeout(); } finally { resolveDone("timed-out"); }
  }, options.budgetMs);
  work()
    .catch((error) => {
      emit({
        level: "error",
        source: "application",
        event: "shutdown-flush-failed",
        fields: { kind: error instanceof Error ? error.name : "unknown" },
      });
    })
    .finally(() => {
      settled = true;
      clearTimeout(timer);
      resolveDone("completed");
    });
  return {
    cancel() { if (!settled) { settled = true; clearTimeout(timer); } },
    done,
  };
}
