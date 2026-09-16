/**
 * M5.6 — workspace + lifecycle schemas.
 *
 * The M5.6 spec (FUTURE/IMPLEMENTATION-README.md line 234) reads:
 *
 * > M5.6 Deliver a two-pane vertical workspace with tabs per pane,
 * > predictable close/focus behavior, keyboard splitter and saved
 * > layout. Distinguish hide view, stop/remove terminal and delete
 * > retained history. Add a command palette for sessions, terminals,
 * > presets, tasks, explorer, settings, hooks and memory; expose
 * > project tags/archive/color/description already supported by
 * > records.
 *
 * Trust model:
 *
 *  - `SavedLayout.version === 3` (bumped from the M3 v2). The
 *    migration adds an empty `layouts` map; persisted layouts carry
 *    a content-addressed SHA-256 `layoutDigest` (excluding ephemeral
 *    fields like `focusedPaneId`).
 *  - `terminalLifecyclePolicySchema = "hide" | "stop-and-remove" |
 *    "delete-history" | "graceful"`. The first three are the new
 *    explicit ops; `graceful` is a backward-compatible alias of
 *    `stop-and-remove` so existing IPC callers keep working.
 *  - `lifecycleDeciderSchema = "user" | "system"`. `delete-history`
 *    rejects `system` — the user must explicitly opt in (mirrors
 *    M3c.3's grant-gate pattern).
 *  - `SessionMetadataPatch` is a partial of `SessionMetadata` (the
 *    existing `tags / archived / color / description` record) used
 *    by `update-session-metadata` so the renderer can PATCH a single
 *    field without round-tripping the whole record.
 */
import { z } from "zod";
import { envProfileSchema } from "./env-profiles";
import { hookSchema } from "./hooks";
import { sessionMetadataSchema } from "./models";

export const LAYOUT_VERSION = 3 as const;

export const savedLayoutVersionSchema = z.literal(LAYOUT_VERSION);

export const paneStateSchema = z.object({
  activeTerminalId: z.string().uuid().nullable(),
  hiddenTerminalIds: z.array(z.string().uuid()).max(64),
}).strict();
export type PaneState = z.infer<typeof paneStateSchema>;

export const splitRatioSchema = z.number().min(0.1).max(0.9);

export const splitConfigSchema = z.object({
  enabled: z.boolean(),
  ratio: splitRatioSchema,
}).strict();
export type SplitConfig = z.infer<typeof splitConfigSchema>;

export const savedLayoutSchema = z.object({
  version: savedLayoutVersionSchema,
  sessionId: z.string().uuid(),
  split: splitConfigSchema,
  top: paneStateSchema,
  bottom: paneStateSchema,
  layoutDigest: z.string().regex(/^[0-9a-f]{64}$/),
  updatedAt: z.string().datetime(),
}).strict();
export type SavedLayout = z.infer<typeof savedLayoutSchema>;

export const sessionMetadataPatchSchema = sessionMetadataSchema.partial().strict();
export type SessionMetadataPatch = z.infer<typeof sessionMetadataPatchSchema>;

export const terminalLifecyclePolicySchema = z.enum([
  "hide",
  "stop-and-remove",
  "delete-history",
  "graceful",
]);
export type TerminalLifecyclePolicy = z.infer<typeof terminalLifecyclePolicySchema>;

export const lifecycleDeciderSchema = z.enum(["user", "system"]);
export type LifecycleDecider = z.infer<typeof lifecycleDeciderSchema>;

/** Effective policy after the `graceful` alias is resolved. */
export const EFFECTIVE_TERMINAL_LIFECYCLE_POLICIES = [
  "hide",
  "stop-and-remove",
  "delete-history",
] as const;
export type EffectiveTerminalLifecyclePolicy = (typeof EFFECTIVE_TERMINAL_LIFECYCLE_POLICIES)[number];

export function resolveTerminalLifecyclePolicy(
  policy: TerminalLifecyclePolicy,
): EffectiveTerminalLifecyclePolicy {
  return policy === "graceful" ? "stop-and-remove" : policy;
}

export const hideTerminalInputSchema = z.object({
  terminalUuid: z.string().uuid(),
}).strict();
export type HideTerminalInput = z.infer<typeof hideTerminalInputSchema>;
export const hideTerminalResultSchema = z.object({
  hidden: z.literal(true),
  terminalUuid: z.string().uuid(),
  hiddenAt: z.string().datetime(),
}).strict();
export type HideTerminalResult = z.infer<typeof hideTerminalResultSchema>;

export const stopAndRemoveTerminalInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  expectedGeneration: z.number().int().min(0).max(1024).default(0),
}).strict();
export type StopAndRemoveTerminalInput = z.infer<typeof stopAndRemoveTerminalInputSchema>;
export const stopAndRemoveTerminalResultSchema = z.object({
  removed: z.literal(true),
  historyRetained: z.literal(true),
  terminalUuid: z.string().uuid(),
  removedAt: z.string().datetime(),
}).strict();
export type StopAndRemoveTerminalResult = z.infer<typeof stopAndRemoveTerminalResultSchema>;

export const deleteTerminalHistoryInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  decider: lifecycleDeciderSchema,
}).strict();
export type DeleteTerminalHistoryInput = z.infer<typeof deleteTerminalHistoryInputSchema>;
export const deleteTerminalHistoryResultSchema = z.object({
  deleted: z.literal(true),
  terminalUuid: z.string().uuid(),
  auditDigest: z.string().regex(/^[0-9a-f]{64}$/),
  linesDropped: z.number().int().min(0).max(2 ** 31),
}).strict();
export type DeleteTerminalHistoryResult = z.infer<typeof deleteTerminalHistoryResultSchema>;

export const updateSessionMetadataInputSchema = z.object({
  sessionId: z.string().uuid(),
  patch: sessionMetadataPatchSchema,
}).strict();
export type UpdateSessionMetadataInput = z.infer<typeof updateSessionMetadataInputSchema>;
export const updateSessionMetadataResultSchema = z.object({
  sessionId: z.string().uuid(),
  applied: z.literal(true),
  metadata: sessionMetadataSchema,
}).strict();
export type UpdateSessionMetadataResult = z.infer<typeof updateSessionMetadataResultSchema>;

export const saveEnvProfilesInputSchema = z.object({
  profiles: z.array(envProfileSchema).min(0).max(100),
}).strict();
export const saveEnvProfilesResultSchema = z.object({
  count: z.number().int().min(0).max(100),
}).strict();

export const saveHooksInputSchema = z.object({
  hooks: z.array(hookSchema).min(0).max(100),
}).strict();
export const saveHooksResultSchema = z.object({
  count: z.number().int().min(0).max(100),
}).strict();

export const viewSessionMemoryInputSchema = z.object({
  sessionId: z.string().min(1).max(256),
  maxTasks: z.number().int().min(1).max(64).optional(),
}).strict();

export const viewTerminalMemoryInputSchema = z.object({
  terminalUuid: z.string().uuid(),
  maxLines: z.number().int().min(1).max(4096).optional(),
}).strict();

export const viewTaskMemoryInputSchema = z.object({
  taskId: z.string().uuid(),
  maxEvents: z.number().int().min(1).max(256).optional(),
}).strict();

export const saveLayoutInputSchema = savedLayoutSchema;
export const saveLayoutResultSchema = z.object({ saved: z.literal(true) }).strict();
export type SaveLayoutResult = z.infer<typeof saveLayoutResultSchema>;

export const readLayoutInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export const readLayoutResultSchema = z.object({
  layout: savedLayoutSchema.nullable(),
}).strict();
export type ReadLayoutResult = z.infer<typeof readLayoutResultSchema>;

export const clearLayoutInputSchema = z.object({
  sessionId: z.string().uuid(),
}).strict();
export const clearLayoutResultSchema = z.object({
  cleared: z.boolean(),
}).strict();
export type ClearLayoutResult = z.infer<typeof clearLayoutResultSchema>;
