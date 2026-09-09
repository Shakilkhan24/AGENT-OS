import { z } from "zod";
import { commandSchema, nameSchema, metadataSchema } from "./models";
import { environmentSchema } from "./env-profiles";
export const launchSchema = z.object({
  command: commandSchema.optional(),
  presetId: z.string().uuid().optional(),
  label: z.string().trim().max(70).optional(),
  count: z.number().int().min(1).max(32).default(1),
  cwd: z.string().max(4096).default(""),
  savePresetAs: nameSchema.optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
  envProfileId: z.string().uuid().optional(),
  env: environmentSchema.optional(),
  promptAnchors: z.array(z.string().min(1).max(200)).max(16).optional(),
  metadata: metadataSchema.optional(),
  originHookId: z.string().uuid().optional(),
}).strict().refine(value => value.command !== undefined || value.presetId !== undefined, "Enter a command or choose a preset");
