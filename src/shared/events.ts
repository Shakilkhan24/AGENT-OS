import { z } from "zod";
import { failureSchema } from "./errors";

const base = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string().datetime(),
  correlationId: z.string().uuid(),
  sourceId: z.string().min(1).max(200),
  sessionId: z.string().uuid().optional(),
  terminalId: z.string().uuid().optional(),
  originHookId: z.string().uuid().optional(),
});
export const terminalStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "prompting",
  "exited",
  "missing",
  "detached",
  "unknown",
  "deleting",
]);
export const stopPolicySchema = z.enum(["graceful", "term", "kill", "force"]);
export type StopPolicy = z.infer<typeof stopPolicySchema>;
export const domainEventSchema = z.discriminatedUnion("type", [
  base.extend({
    type: z.literal("session-changed"),
    data: z.object({ action: z.enum(["created", "updated", "deleted"]) }),
  }),
  base.extend({
    type: z.literal("terminal-status"),
    data: z.object({
      status: terminalStatusSchema,
      exitCode: z.number().int().optional(),
      exitSignal: z.string().max(40).optional(),
    }),
  }),
  base.extend({
    type: z.literal("launch-progress"),
    data: z.object({
      launchId: z.string().uuid(),
      completed: z.number().int().nonnegative(),
      total: z.number().int().min(1).max(32),
      state: z.enum(["queued", "running", "completed", "cancelled"]),
      error: failureSchema.optional(),
    }),
  }),
  base.extend({ type: z.literal("operation-failed"), data: failureSchema }),
  base.extend({ type: z.literal("engine-restored"), data: z.object({}) }),
  base.extend({
    type: z.literal("prompt-reached"),
    data: z.object({ anchor: z.string().max(200) }),
  }),
  base.extend({
    type: z.literal("attachment-state"),
    data: z.object({
      viewId: z.string().max(100),
      state: z.enum(["attached", "detached", "disconnected"]),
    }),
  }),
  base.extend({
    type: z.literal("stop-progress"),
    data: z.object({
      policy: stopPolicySchema,
      stage: z.enum(["interrupt", "term", "kill", "removed"]),
      pids: z.array(z.number().int().positive()).max(4096),
    }),
  }),
  base.extend({
    type: z.literal("files-changed"),
    data: z.object({ path: z.string().max(4096) }),
  }),
  base.extend({ type: z.literal("settings-changed"), data: z.object({}) }),
  base.extend({
    type: z.literal("hook-fired"),
    data: z.object({
      hookId: z.string().uuid(),
      eventSeq: z.number().int().nonnegative(),
    }),
  }),
]);
export type DomainEvent = z.infer<typeof domainEventSchema>;
type Input<T> = T extends unknown
  ? Omit<T, "seq" | "at" | "correlationId"> & { correlationId?: string }
  : never;
export type DomainEventInput = Input<DomainEvent>;
export const replaySchema = z.object({
  events: z.array(domainEventSchema).max(5000),
  oldestSeq: z.number().int().nonnegative(),
  latestSeq: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export type EventReplay = z.infer<typeof replaySchema>;
export interface EventStream {
  publish(event: DomainEventInput): Promise<DomainEvent>;
  publishMany(events: DomainEventInput[]): Promise<DomainEvent[]>;
  replay(fromSeq: number): EventReplay;
  subscribe(listener: (event: DomainEvent) => void): () => void;
}
