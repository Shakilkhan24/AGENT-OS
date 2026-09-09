import type { DraftInput, DraftSummary } from "../shared/drafts";
/** Serialization prevents a late mirror from resurrecting a saved/discarded draft. */
export class DraftMirror {
  private pending?: DraftInput;
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private id?: string;
  private generation = 0;
  constructor(private write: (input: DraftInput) => Promise<DraftSummary>, private remove: (id: string) => Promise<void>,
    private report: (error: unknown) => void, private delay = 750) {}
  schedule(input: DraftInput) {
    this.generation++; this.pending = input; clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(this.report); }, this.delay);
  }
  restore(id: string) { this.id = id; }
  setDelay(ms: number) { this.delay = ms; }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const input = this.pending; this.pending = undefined;
    const generation = this.generation;
    if (!input) return this.queue;
    const operation = this.queue.catch(() => {}).then(async () => {
      try { this.id = (await this.write(input)).id; }
      catch (error) { if (generation === this.generation) this.pending ??= input; throw error; }
    });
    this.queue = operation;
    return operation;
  }
  discard(): Promise<void> {
    this.generation++; clearTimeout(this.timer); this.pending = undefined;
    this.queue = this.queue.catch(() => {}).then(async () => { if (this.id) await this.remove(this.id); this.id = undefined; });
    return this.queue;
  }
}
