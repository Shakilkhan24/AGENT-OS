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
import { Mutex } from "./mutex";
import { log } from "./logging";

const journalSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  events: z.array(domainEventSchema).max(5000),
});
/** A bounded durable event history; notifications follow persistence in sequence order. */
export class EventBus implements EventStream {
  private events: DomainEvent[] = [];
  private sequence = 0;
  private mutex = new Mutex();
  private listeners = new Set<(event: DomainEvent) => void>();
  private initialized = false;
  readonly file: string;
  constructor(
    directory: string,
    private limit = 1000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new Error("Invalid event retention limit");
    this.file = path.join(directory, "events.json");
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
    return this.mutex.run(async () => {
      if (!this.initialized) throw new Error("Event bus is not initialized");
      const event = domainEventSchema.parse({
        ...input,
        seq: this.sequence + 1,
        at: new Date().toISOString(),
        correlationId: input.correlationId || crypto.randomUUID(),
      });
      const events = [...this.events, event].slice(-this.limit);
      await atomicJson(this.file, { version: 1, sequence: event.seq, events });
      this.events = events;
      this.sequence = event.seq;
      for (const listener of this.listeners) {
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
      return structuredClone(event);
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
  async flush() {
    await this.mutex.run(async () => {});
  }
}
