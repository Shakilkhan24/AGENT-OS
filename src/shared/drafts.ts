import { z } from "zod";
import { filePathSchema, hashSchema } from "./files";
export const draftInputSchema = z.object({ sessionId: z.string().uuid(), path: filePathSchema.min(1), baseHash: hashSchema, content: z.string().max(2 * 1024 * 1024) });
export const draftSchema = draftInputSchema.extend({ id: hashSchema, updatedAt: z.string().datetime() });
export const draftSummarySchema = draftSchema.omit({ content: true });
export type DraftInput = z.infer<typeof draftInputSchema>;
export type Draft = z.infer<typeof draftSchema>;
export type DraftSummary = z.infer<typeof draftSummarySchema>;
