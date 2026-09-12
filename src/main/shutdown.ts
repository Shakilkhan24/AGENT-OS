/** Bounded shutdown: drain accepted operations, report failures, preserve tmux work. */
import { log } from "./logging";

export interface ShutdownWatchdog {
  /** Cancel the watchdog (call when close() resolves normally). */
  cancel(): void;
  /** Resolves when the close completes or the watchdog trips. */
  done: Promise<"completed" | "failed" | "timed-out" | "cancelled">;
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
  let resolveDone!: (result: "completed" | "failed" | "timed-out" | "cancelled") => void;
  const done = new Promise<"completed" | "failed" | "timed-out" | "cancelled">((resolve) => {
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
  let outcome: "completed" | "failed" = "completed";
  Promise.resolve().then(work)
    .catch((error) => {
      outcome = "failed";
      emit({
        level: "error",
        source: "application",
        event: "shutdown-flush-failed",
        fields: { kind: error instanceof Error ? error.name : "unknown" },
      });
    })
    .finally(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone(outcome);
    });
  return {
    cancel() { if (!settled) { settled = true; clearTimeout(timer); resolveDone("cancelled"); } },
    done,
  };
}
