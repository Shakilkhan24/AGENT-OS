import { z } from "zod";
import {
  workflowExecutorMaxFanoutSchema,
  workflowExecutorDefaultStepTimeoutMsSchema,
  workflowExecutorWaitPollMsSchema,
  DEFAULT_MAX_FANOUT,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_WAIT_POLL_MS,
} from "./workflow-executor-schema";

export const settingsSchema = z
  .object({
    version: z.literal(1).default(1),
    pollIntervalMs: z.number().int().min(250).max(30000).default(2000),
    fileTimeoutMs: z.number().int().min(100).max(120000).default(15000),
    fileQueueLimit: z.number().int().min(1).max(256).default(64),
    draftIntervalMs: z.number().int().min(100).max(5000).default(750),
    draftLimit: z.number().int().min(1).max(100).default(50),
    eventReplayLimit: z.number().int().min(50).max(5000).default(1000),
    logRetentionDays: z.number().int().min(1).max(30).default(7),
    inputBudgetBytes: z
      .number()
      .int()
      .min(65536)
      .max(8 * 1024 * 1024)
      .default(2 * 1024 * 1024),
    historyLines: z.number().int().min(1000).max(50000).default(20000),
    attachmentCacheSize: z.number().int().min(0).max(16).default(8),
    attachmentIdleMs: z.number().int().min(0).max(120000).default(30000),
    gracefulStopMs: z.number().int().min(100).max(10000).default(1000),
    fileWatching: z.boolean().default(false),
    shellMode: z.enum(["login", "clean"]).default("login"),
    workflowExecutorMaxFanout: workflowExecutorMaxFanoutSchema.default(DEFAULT_MAX_FANOUT),
    workflowExecutorDefaultStepTimeoutMs: workflowExecutorDefaultStepTimeoutMsSchema.default(DEFAULT_STEP_TIMEOUT_MS),
    workflowExecutorWaitPollMs: workflowExecutorWaitPollMsSchema.default(DEFAULT_WAIT_POLL_MS),
    /**
     * M9.4: telemetry is off by default. No uploader ships in this
     * release — the flag exists so a future M-bullet can wire a
     * destination without schema churn. The renderer CSP
     * `connect-src 'none'` keeps the flag inert for now.
     */
    telemetry: z.boolean().default(false),
  })
  .strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = settingsSchema.parse({});
