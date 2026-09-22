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
import { classifySourceForRetention } from "../release/compatibility-check";
import type { RetentionClass } from "../release/diagnostic-scrubber";

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
  private closed = false;
  private journal!: Debouncer<JournalState>;
  /**
   * M9.4 retention floor: per-seq retention classification. The
   * domain-event schema does NOT carry a `retentionClass` field, so
   * the bus keeps an out-of-band map keyed by `seq`. The map is
   * populated from `classifySourceForRetention(event.sourceId)` when
   * the event is published; entries whose sourceId maps to one of
   * the protected classes survive the hard-cap slice that limits
   * operational events to `limit`. The default for any source the
   * classifier doesn't recognise is `operational`.
   */
  private retentionClassBySeq = new Map<number, RetentionClass>();
  readonly file: string;
  constructor(
    directory: string,
    private limit = 1000,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000)
      throw new Error("Invalid event retention limit");
    this.file = path.join(directory, "events.json");
    this.journal = new Debouncer<JournalState>(
      (state) => atomicJson(this.file, state),
      0,
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
      // Re-derive retention classes from the persisted `sourceId` so a
      // restarted bus honours the same floor as the original.
      for (const event of this.events) {
        this.retentionClassBySeq.set(event.seq, classifySourceForRetention(event.sourceId));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.initialized = true;
  }
  publish(input: DomainEventInput): Promise<DomainEvent> {
    return this.publishMany([input]).then(events => events[0]);
  }
  /** Persist the batch before publishing it. Failed writes do not advance replay. */
  publishMany(inputs: DomainEventInput[]): Promise<DomainEvent[]> {
    return this.mutex.run(async () => {
      if (!this.initialized) throw new Error("Event bus is not initialized");
      if (this.closed) throw new Error("Event bus is closed");
      if (!inputs.length) return [];
      if (inputs.length > 5000) throw new Error("Event batch is too large");
      const batch = inputs.map((input, index) => {
        const seq = this.sequence + index + 1;
        // M9.4: classify the event up-front so the slice step below
        // can keep protected entries regardless of the cap.
        const parsed = domainEventSchema.parse({
          ...input,
          seq,
          at: new Date().toISOString(),
          correlationId: input.correlationId || crypto.randomUUID(),
        });
        this.retentionClassBySeq.set(seq, classifySourceForRetention(parsed.sourceId));
        return parsed;
      });
      const sequence = batch.at(-1)!.seq;
      // M9.4: class-aware slice. Operational events are bounded at
      // `limit`; protected events (pending-decision / live-intent /
      // recoverable-candidate) are kept past the cap. The replay
      // returned to callers sees the merged stream in seq order.
      const combined = [...this.events, ...batch];
      const protectedSet = new Set<DomainEvent>();
      const operational: DomainEvent[] = [];
      for (const event of combined) {
        const cls = this.retentionClassBySeq.get(event.seq) ?? "operational";
        if (cls === "operational") operational.push(event);
        else protectedSet.add(event);
      }
      const trimmedOperational = operational.slice(-this.limit);
      const retained = [...protectedSet, ...trimmedOperational].sort(
        (a, b) => a.seq - b.seq,
      );
      // Drop retention classifications for events that fell out of
      // `retained` so the map doesn't grow unboundedly.
      const retainedSeq = new Set(retained.map((e) => e.seq));
      for (const seq of [...this.retentionClassBySeq.keys()]) {
        if (!retainedSeq.has(seq)) this.retentionClassBySeq.delete(seq);
      }
      const events = retained;
      await this.journal.schedule({ version: 1, sequence, events });
      this.sequence = sequence;
      this.events = events;
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
  /**
   * M9.4 test seam: how many retained events carry a non-operational
   * retention class. The bus keeps these events past the `limit` cap
   * so the count can grow above the operational bound.
   */
  protectedCount(): number {
    let n = 0;
    for (const cls of this.retentionClassBySeq.values()) {
      if (cls !== "operational") n += 1;
    }
    return n;
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
      this.closed = true;
      await this.journal.close();
    });
  }
}
