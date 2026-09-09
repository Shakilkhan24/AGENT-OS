import { z } from "zod";
import { environmentSchema, envProfileSchema } from "./env-profiles";
import { hookSchema } from "./hooks";
import { stopPolicySchema } from "./events";
export const nameSchema = z.string().trim().min(1).max(80);
export const commandSchema = z
  .string()
  .max(8192)
  .refine((value) => !value.includes("\0"));
export const metadataSchema = z
  .record(z.string().max(80), z.string().max(1000))
  .refine((value) => Object.keys(value).length <= 32);
export const sessionMetadataSchema = z
  .object({
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    archived: z.boolean().default(false),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .optional(),
    description: z.string().max(2000).default(""),
  })
  .strict();
export type SessionMetadata = z.infer<typeof sessionMetadataSchema>;
export const presetSchema = z.object({
  id: z.string().uuid(),
  name: nameSchema,
  command: commandSchema,
});
export const terminalSchema = z.object({
  id: z.string().uuid(),
  label: nameSchema,
  cwd: z.string(),
  command: commandSchema,
  createdAt: z.string(),
  deleting: z.boolean().optional(),
  deletionPolicy: stopPolicySchema.optional(),
  launchError: z.string().optional(),
  startedAt: z.string().datetime().optional(),
  endedAt: z.string().datetime().optional(),
  exitSignal: z.string().max(40).optional(),
  exitCode: z.number().int().optional(),
  metadata: metadataSchema.optional(),
  env: environmentSchema.optional(),
  envProfileId: z.string().uuid().optional(),
  promptAnchors: z.array(z.string().min(1).max(200)).max(16).optional(),
  launchState: z
    .enum(["starting", "running", "cancelled", "failed"])
    .optional(),
  originHookId: z.string().uuid().optional(),
});
export const sessionSchema = z.object({
  id: z.string().uuid(),
  name: nameSchema,
  directory: z.string(),
  identity: z.string(),
  createdAt: z.string(),
  terminals: z.array(terminalSchema),
  deleting: z.boolean().optional(),
  deletionPolicy: stopPolicySchema.optional(),
  metadata: sessionMetadataSchema.optional(),
});
export const launchRecordSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  key: z.string().max(128).optional(),
  fingerprint: z.string(),
  expiresAt: z.number(),
  terminalIds: z.array(z.string().uuid()).max(32),
  state: z.enum(["queued", "running", "completed", "cancelled"]),
  completed: z.number().int().nonnegative(),
  errors: z
    .array(z.object({ terminalId: z.string().uuid(), error: z.string() }))
    .max(32),
});
export type LaunchRecord = z.infer<typeof launchRecordSchema>;
export const legacyStateSchema = z.object({
  version: z.literal(1),
  presets: z.array(presetSchema).max(100),
  sessions: z.array(sessionSchema),
});
export const stateSchema = z.object({
  version: z.literal(2),
  presets: z.array(presetSchema).max(100),
  sessions: z.array(sessionSchema),
  envProfiles: z.array(envProfileSchema).max(100),
  hooks: z.array(hookSchema).max(100),
  launches: z.array(launchRecordSchema).max(1000),
});
