/**
 * M3b.2 — byte-budgeted writer.
 *
 * Extracted from `src/main/pty-attachment.ts:22-95` so the orchestrator can
 * pause/resume the provider handle's stdout drain based on consumer ack
 * pressure. The thresholds are unchanged from the renderer path:
 *
 *  - `LOW_WATERMARK`  (64 KiB): below this the source is **resumed**.
 *  - `HIGH_WATERMARK` (256 KiB): above this the source is **paused**.
 *  - `INPUT_CAP`      (4 MiB): the upstream stdin queue refuses new writes
 *    past this depth (matches `SCRIPTED_INPUT_CAP_BYTES` and the cap used by
 *    `main/pty-attachment.ts:61`).
 *
 * The struct is intentionally small and side-effect-free at construction.
 * The owner wires the `pause`/`resume` callbacks at attach time so the
 * writer can be reused across scripted and native handles without
 * coupling to either transport.
 */
export const LOW_WATERMARK = 64 * 1024;
export const HIGH_WATERMARK = 256 * 1024;
export const INPUT_CAP = 4 * 1024 * 1024;

export interface BudgetedWriterCallbacks {
  /** Called when the writer decides the upstream should stop draining. */
  readonly pause: () => void;
  /** Called when the writer decides the upstream can drain again. */
  readonly resume: () => void;
}

export interface BudgetedWriter {
  /** Total bytes currently outstanding (delivered minus acked). */
  readonly outstanding: number;
  /** Has the writer paused the upstream? */
  readonly paused: boolean;
  /** Record N delivered bytes; flips `paused` when crossing the high watermark. */
  deliver(bytes: number): void;
  /** Acknowledge N consumed bytes; flips `paused` when crossing back below the low watermark. */
  acknowledge(bytes: number): void;
  /** Reset state (used on disconnect / re-attach). */
  reset(): void;
}

/**
 * Construct a byte-budgeted writer. The callbacks fire synchronously when
 * the watermark is crossed; the consumer is responsible for translating
 * `pause`/`resume` into whatever the transport supports.
 */
export function createBudgetedWriter(callbacks: BudgetedWriterCallbacks): BudgetedWriter {
  let outstanding = 0;
  let paused = false;
  function setPaused(next: boolean): void {
    if (next === paused) return;
    paused = next;
    if (next) callbacks.pause();
    else callbacks.resume();
  }
  return {
    get outstanding() { return outstanding; },
    get paused() { return paused; },
    deliver(bytes) {
      if (bytes < 0) throw new Error(`BudgetedWriter.deliver: negative byte count ${bytes}`);
      outstanding += bytes;
      if (outstanding >= HIGH_WATERMARK) setPaused(true);
    },
    acknowledge(bytes) {
      if (bytes < 0) throw new Error(`BudgetedWriter.acknowledge: negative byte count ${bytes}`);
      outstanding = Math.max(0, outstanding - bytes);
      if (outstanding < LOW_WATERMARK) setPaused(false);
    },
    reset() {
      outstanding = 0;
      setPaused(false);
    },
  };
}