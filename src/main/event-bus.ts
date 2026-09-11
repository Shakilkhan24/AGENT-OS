import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  domainEventSchema,
  type DomainEvent,
  type DomainEventInput,
  type EventReplay,
  type EventStream,
} from "../shared/events";
import { atomicJson } from "./atomic";
import { Debouncer } from "./debouncer";
import { Mutex } from "./mutex";
import { log } from "./logging";

const journalSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  events: z.array(domainEventSchema).max(5000),
});
type JournalState = { version: 1; sequence: number; events: DomainEvent[] };
/** A bounded durable event history; notifications follow persistence in sequence order. */
export class EventBus implements EventStream {
  private events: DomainEvent[] = [];
  private sequence = 0;
  private mutex = new Mutex();
  private listeners = new Set<(event: DomainEvent) => void>();
  private initialized = false;
  private journal!: Debouncer<JournalState>;
  readonly file: string;
  constructor(
    directory: string,
    private limit = 1000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new Error("Invalid event retention limit");
    this.file = path.join(directory, "events.json");
    this.journal = new Debouncer<JournalState>(
      (state) => atomicJson(this.file, state, { durability: "async-strong" }),
      25,
    );
  }
  async initialize() {
    try {
      const journal = journalSchema.parse(
        JSON.parse(await readFile(this.file, "utf8")),
      );
      let previous = 0;
      for (const event of journal.events) {
        if (event.seq <= previous || event.seq > journal.sequence)
          throw new Error("Invalid event sequence; journal preserved");
        previous = event.seq;
      }
      this.events = journal.events.slice(-this.limit);
      this.sequence = journal.sequence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }
  publish(input: DomainEventInput): Promise<DomainEvent> {
    return this.publishMany([input]).then(events => events[0]);
  }
  /**
   * Enqueue `inputs` for ordered, durable delivery. Persistence coalesces:
   * a burst of concurrent `publishMany` calls collapses into one journal
   * write per debounce window. Subscribers always see events in sequence
   * order as soon as they are enqueued; only the on-disk journal lags by
   * up to one debounce window.
   *
   * Returns the assigned events. Resolves when the events are enqueued;
   * the durable write completes slightly later. Use `flush()` to await
   * durable persistence before shutdown or when the next test asserts on
   * the journal file.
   */
  publishMany(inputs: DomainEventInput[]): Promise<DomainEvent[]> {
    return this.mutex.run(async () => {
      if (!this.initialized) throw new Error("Event bus is not initialized");
      if (!inputs.length) return [];
      if (inputs.length > 5000) throw new Error("Event batch is too large");
      const batch = inputs.map((input, index) => domainEventSchema.parse({
        ...input,
        seq: this.sequence + index + 1,
        at: new Date().toISOString(),
        correlationId: input.correlationId || crypto.randomUUID(),
      }));
      this.sequence = batch.at(-1)!.seq;
      this.events = [...this.events, ...batch].slice(-this.limit);
      for (const event of batch) for (const listener of this.listeners) {
        try {
          listener(structuredClone(event));
        } catch {
          log({
            level: "warning",
            source: "events",
            event: "subscriber-failed",
            correlationId: event.correlationId,
          });
        }
      }
      void this.journal.schedule({
        version: 1,
        sequence: this.sequence,
        events: this.events,
      });
      return structuredClone(batch);
    });
  }
  replay(fromSeq: number): EventReplay {
    z.number().int().nonnegative().parse(fromSeq);
    const oldestSeq = this.events[0]?.seq ?? this.sequence + 1;
    return {
      events: structuredClone(
        this.events.filter((event) => event.seq > fromSeq),
      ),
      oldestSeq,
      latestSeq: this.sequence,
      truncated: fromSeq < oldestSeq - 1 || fromSeq > this.sequence,
    };
  }
  subscribe(listener: (event: DomainEvent) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Block until pending journal writes are durable. */
  async flush() {
    // Hold the mutex while draining the journal so no new publishes can land
    // between our check and the actual flush.
    await this.mutex.run(async () => {
      await this.journal.flush();
    });
  }
  /**
   * Flush and disarm. After `close()` returns, any further `publish*` calls
   * will throw (the underlying mutex is held until close completes, so no
   * publish can land during the disarm window).
   */
  async close() {
    await this.mutex.run(async () => {
      await this.journal.flush();
      await this.journal.close();
    });
  }
}
