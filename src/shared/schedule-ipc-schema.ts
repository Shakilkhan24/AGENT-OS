/**
 * M7 — IPC schema for schedule management.
 *
 * These schemas are the wire contract for the six schedule methods
 * registered in `RuntimeWorkspace.connect`. Every input runs through
 * `method(input, output)` so a malformed wire value fails at the
 * dispatcher boundary, not silently in the handler.
 *
 * The Zod surfaces intentionally mirror the dispatcher surface so a
 * renderer's preview exactly matches what the runtime will admit.
 * `hostId` + `tzdataVersion` are stamped on every revision at
 * publish-time from `workspace.bootIdentity` / `process.versions.icu`.
 */
import { z } from "zod";
import {
  scheduleRuleSchema,
  scheduleInputSchema,
} from "../runtime/db/schedule-schema";

export const upsertScheduleInputSchema = z.tuple([scheduleInputSchema]);
export type UpsertScheduleInput = z.input<typeof upsertScheduleInputSchema>;

export const upsertScheduleResultSchema = z.object({ scheduleId: z.string().min(1).max(128) }).strict();
export type UpsertScheduleResult = z.output<typeof upsertScheduleResultSchema>;

export const publishScheduleRevisionInputSchema = z.tuple([
  z.object({
    scheduleId: z.string().min(1).max(128),
    rule: scheduleRuleSchema,
    timezone: z.string().min(1).max(64),
    recipeId: z.string().min(1).max(128),
    overlapPolicy: z.enum(["skip", "allow"]).default("skip"),
    graceWindowMs: z.number().int().min(0).max(60 * 60_000).default(0),
    publishedBy: z.string().min(1).max(256),
  }).strict(),
]);
export type PublishScheduleRevisionInput = z.input<typeof publishScheduleRevisionInputSchema>;

export const publishScheduleRevisionResultSchema = z.object({
  scheduleId: z.string().min(1).max(128),
  revision: z.number().int().min(1).max(2_048),
  revisionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  publishedAt: z.string().datetime(),
}).strict();
export type PublishScheduleRevisionResult = z.output<typeof publishScheduleRevisionResultSchema>;

export const promoteScheduleRevisionInputSchema = z.tuple([
  z.object({
    scheduleId: z.string().min(1).max(128),
    revision: z.number().int().min(1).max(2_048),
    to: z.enum(["enabled", "revoked"]),
  }).strict(),
]);
export type PromoteScheduleRevisionInput = z.input<typeof promoteScheduleRevisionInputSchema>;

export const promoteScheduleRevisionResultSchema = z.object({
  scheduleId: z.string().min(1).max(128),
  revision: z.number().int().min(1).max(2_048),
  status: z.enum(["enabled", "revoked", "superseded"]),
}).strict();
export type PromoteScheduleRevisionResult = z.output<typeof promoteScheduleRevisionResultSchema>;

export const setScheduleStatusInputSchema = z.tuple([
  z.object({
    scheduleId: z.string().min(1).max(128),
    status: z.enum(["enabled", "paused", "disabled"]),
  }).strict(),
]);
export type SetScheduleStatusInput = z.input<typeof setScheduleStatusInputSchema>;

export const setScheduleStatusResultSchema = z.object({
  scheduleId: z.string().min(1).max(128),
  status: z.enum(["enabled", "paused", "disabled"]),
}).strict();
export type SetScheduleStatusResult = z.output<typeof setScheduleStatusResultSchema>;

export const listSchedulesInputSchema = z.tuple([]);
export const listSchedulesResultSchema = z.array(z.object({
  scheduleId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(256),
  status: z.enum(["enabled", "paused", "disabled"]),
  recipeId: z.string().min(1).max(128),
  timezone: z.string().min(1).max(64),
}).strict());
export type ListSchedulesResult = z.output<typeof listSchedulesResultSchema>;

export const previewScheduleFiringsInputSchema = z.tuple([
  z.object({
    scheduleId: z.string().min(1).max(128),
    fromUtc: z.string().datetime(),
    count: z.number().int().min(1).max(64),
  }).strict(),
]);
export type PreviewScheduleFiringsInput = z.input<typeof previewScheduleFiringsInputSchema>;

export const previewScheduleFiringsResultSchema = z.object({
  scheduleId: z.string().min(1).max(128),
  firings: z.array(z.object({
    intendedUtc: z.string().datetime(),
    localTimeIso: z.string().datetime(),
    skipped: z.boolean(),
  }).strict()),
}).strict();
export type PreviewScheduleFiringsResult = z.output<typeof previewScheduleFiringsResultSchema>;

void z;
