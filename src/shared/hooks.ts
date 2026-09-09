import { z } from "zod";
import { domainEventSchema } from "./events";
export const hookSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(80),
    enabled: z.boolean().default(false),
    event: z.enum(
      domainEventSchema.options.map((option) => option.shape.type.value),
    ),
    sessionId: z.string().uuid().optional(),
    terminalId: z.string().uuid().optional(),
    match: z.string().max(200).optional(),
    action: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("notify"),
        message: z.string().min(1).max(1000),
      }),
      z.object({
        type: z.literal("run-command-in-terminal"),
        command: z
          .string()
          .min(1)
          .max(8192)
          .refine((value) => !value.includes("\0")),
      }),
      z.object({
        type: z.literal("open-file"),
        path: z
          .string()
          .min(1)
          .max(4096)
          .refine(
            (value) =>
              !value.startsWith("/") &&
              !value.split("/").includes("..") &&
              !value.includes("\0"),
          ),
      }),
    ]),
  })
  .strict();
export type Hook = z.infer<typeof hookSchema>;
