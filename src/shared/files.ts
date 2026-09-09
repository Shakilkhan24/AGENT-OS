import { z } from "zod";
import { failureSchema } from "./errors";
export const filePathSchema = z.string().max(4096).refine(value => !value.includes("\0") && !value.startsWith("/") && !value.split("/").includes(".."), "Use a path within the session directory");
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const fileEntrySchema = z.object({ name: z.string().max(1024), kind: z.enum(["directory", "file", "blocked"]), size: z.number().int().nonnegative() });
export const filePreviewSchema = z.object({ kind: z.enum(["text", "image", "binary"]), content: z.string().max(14 * 1024 * 1024), size: z.number().int().nonnegative(), hash: hashSchema.optional() }).refine(value => value.kind !== "text" || value.hash !== undefined);
export const filePageSchema = z.object({ entries: z.array(fileEntrySchema).max(500), cursor: z.string().uuid().optional(), truncated: z.boolean() });
export const writeResultSchema = z.discriminatedUnion("saved", [
  z.object({ saved: z.literal(true), hash: hashSchema }),
  z.object({ saved: z.literal(false), current: filePreviewSchema }),
]);
export const fileActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list"), path: filePathSchema }),
  z.object({ action: z.literal("list-page"), path: filePathSchema, cursor: z.string().uuid().optional(), limit: z.number().int().min(1).max(500).optional() }),
  z.object({ action: z.literal("read"), path: filePathSchema }),
  z.object({ action: z.literal("preview"), path: filePathSchema }),
  z.object({ action: z.literal("write"), path: filePathSchema, content: z.string().max(2 * 1024 * 1024), expectedHash: hashSchema }),
  z.object({ action: z.literal("create"), path: filePathSchema, kind: z.enum(["file", "directory"]) }),
  z.object({ action: z.literal("move"), path: filePathSchema, destination: filePathSchema }),
  z.object({ action: z.literal("delete"), path: filePathSchema }),
]);
export const directoryActionSchema = z.object({ action: z.literal("directory"), path: filePathSchema });
export const resultSchemas = {
  list: z.array(fileEntrySchema).max(20000),
  "list-page": filePageSchema,
  read: z.string().max(2 * 1024 * 1024),
  preview: filePreviewSchema,
  write: writeResultSchema,
  create: z.null(), move: z.null(), delete: z.null(), unregister: z.null(),
  directory: z.string().max(4096),
  register: z.object({ directory: z.string().max(4096), identity: z.string().regex(/^\d+:\d+$/) }),
};
export const workerResponseSchema = z.discriminatedUnion("ok", [
  z.object({ apiVersion: z.literal(2), id: z.number().int().positive(), correlationId: z.string().uuid(), ok: z.literal(true), result: z.unknown() }),
  z.object({ apiVersion: z.literal(2), id: z.number().int().positive(), correlationId: z.string().uuid(), ok: z.literal(false), error: failureSchema }),
]);
export type FileAction = z.infer<typeof fileActionSchema>;
export type DirectoryAction = z.infer<typeof directoryActionSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type FilePreview = z.infer<typeof filePreviewSchema>;
export type FilePage = z.infer<typeof filePageSchema>;
export type FileResults = { [K in keyof typeof resultSchemas]: z.infer<(typeof resultSchemas)[K]> };
