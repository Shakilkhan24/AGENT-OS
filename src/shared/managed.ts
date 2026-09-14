/**
 * M3a — Managed-work entity schemas.
 *
 * Eight entity families for the M3 "manage one repair" arc:
 *  - `task` — durable unit of work the user wants done;
 *  - `run` — one execution of a task (a task can exist without any run);
 *  - `invocation` — one provider round-trip inside a run (with idempotency);
 *  - `dispatch_intent` — one typed method invocation recorded before the
 *    runtime commits to a backend claim;
 *  - `workspace` — the working directory (a Git worktree or a recoverable
 *    snapshot) bound to a task;
 *  - `grant` — a typed authority a principal asks for; never self-approved;
 *  - `artifact_reference` — content-addressed pin of an external resource
 *    the receipt references;
 *  - `attention_item` — reviewable issue a renderer must surface.
 *
 * Identity fields (`providerVersion`, `model`, `accountMode`, `hostId`,
 * `baseIdentity`, `rootIdentity`) are recorded on every entity that crosses
 * the runtime/provider boundary so a reconnecting peer can prove its identity.
 *
 * The shared schemas here are the public shape (what callers see). The DB
 * row schemas in `runtime/db/schema.ts` extend these with the row's id +
 * timestamps; service modules re-parse row reads through the row schemas so
 * a future migration that adds a column is a single Zod change.
 */
import { z } from "zod";

// ── Common identity fragments ───────────────────────────────────────────────

/** UUID v4 — every entity id uses a bare UUID, no prefixes. */
const idSchema = z.string().uuid();

/** ISO-8601 timestamp (the `meta.generation` checkpoint uses the same shape). */
const timestampSchema = z.string().datetime();

/** Free-text identity, max 256 chars (provider version, model, account mode …). */
const identityStringSchema = z.string().trim().min(1).max(256);

/** Stable host id — opaque to callers but bounded. */
const hostIdSchema = z.string().min(1).max(128);

/** Git base identity (commit SHA), 7 to 64 lowercase hex chars. */
const commitShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);

/** Filesystem root identity (dev:ino). */
const rootIdentitySchema = z.string().regex(/^\d+:\d+$/);

/** Provider-derived identity triple — every cross-boundary event carries it. */
export const providerIdentitySchema = z.object({
  providerVersion: identityStringSchema,
  model: identityStringSchema,
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
}).strict();
export type ProviderIdentity = z.infer<typeof providerIdentitySchema>;

// ── Task ─────────────────────────────────────────────────────────────────────

export const taskStatusSchema = z.enum(["draft", "ready", "active", "done", "abandoned"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

/** Public shape of a task — no DB columns leaked. */
export const taskSchema = z.object({
  id: idSchema,
  title: z.string().trim().min(1).max(200),
  objective: z.string().max(8000),
  status: taskStatusSchema,
  projectId: z.string().max(256),
  providerVersion: identityStringSchema.nullable(),
  model: identityStringSchema.nullable(),
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]).nullable(),
  hostId: hostIdSchema,
  baseIdentity: commitShaSchema.nullable(),
  rootIdentity: rootIdentitySchema.nullable(),
  effectiveInputs: z.record(z.string().max(80), z.unknown()).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Task = z.infer<typeof taskSchema>;

// ── Run ──────────────────────────────────────────────────────────────────────

export const runStatusSchema = z.enum(["queued", "running", "completed", "cancelled", "failed"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  status: runStatusSchema,
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  baseRevision: commitShaSchema.nullable(),
  terminalUuid: z.string().uuid().nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type Run = z.infer<typeof runSchema>;

// ── Invocation ───────────────────────────────────────────────────────────────

export const invocationStatusSchema = z.enum(["pending", "admitted", "spawned", "observing", "done", "error"]);
export type InvocationStatus = z.infer<typeof invocationStatusSchema>;

export const invocationSchema = z.object({
  id: idSchema,
  runId: idSchema,
  attempt: z.number().int().min(1).max(1024),
  status: invocationStatusSchema,
  idempotencyKey: z.string().trim().min(1).max(256),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/),
  providerVersion: identityStringSchema,
  model: identityStringSchema,
  accountMode: z.enum(["anonymous", "authenticated", "trusted-host"]),
  startedAt: timestampSchema.nullable(),
  endedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
}).strict();
export type Invocation = z.infer<typeof invocationSchema>;

// ── DispatchIntent ───────────────────────────────────────────────────────────

export const dispatchIntentStateSchema = z.enum(["recorded", "claimed", "spawned", "acked", "expired"]);
export type DispatchIntentState = z.infer<typeof dispatchIntentStateSchema>;

export const dispatchIntentSchema = z.object({
  id: idSchema,
  runId: idSchema,
  invocationId: idSchema.nullable(),
  method: z.string().min(1).max(128),
  argsJson: z.string().max(64 * 1024),
  scopeJson: z.string().max(64 * 1024),
  deadlineAt: timestampSchema,
  state: dispatchIntentStateSchema,
  createdAt: timestampSchema,
}).strict();
export type DispatchIntent = z.infer<typeof dispatchIntentSchema>;

// ── Workspace ────────────────────────────────────────────────────────────────

export const workspaceKindSchema = z.enum(["git-worktree", "snapshot"]);
export type WorkspaceKind = z.infer<typeof workspaceKindSchema>;

export const workspaceSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  kind: workspaceKindSchema,
  location: z.string().min(1).max(1024),
  baseIdentity: commitShaSchema.nullable(),
  worktreePath: z.string().min(1).max(1024).nullable(),
  headRevision: commitShaSchema.nullable(),
  leaseId: z.string().uuid().nullable(),
  createdAt: timestampSchema,
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;

// ── Grant ────────────────────────────────────────────────────────────────────

export const grantKindSchema = z.enum(["capability", "authority"]);
export type GrantKind = z.infer<typeof grantKindSchema>;

export const grantStateSchema = z.enum(["pending", "approved", "denied", "expired"]);
export type GrantState = z.infer<typeof grantStateSchema>;

export const grantSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  kind: grantKindSchema,
  scopeJson: z.string().max(64 * 1024),
  principal: z.string().min(1).max(256),
  digestsJson: z.string().max(64 * 1024),
  state: grantStateSchema,
  requestedAt: timestampSchema,
  decidedAt: timestampSchema.nullable(),
  decidedBy: z.string().min(1).max(256).nullable(),
}).strict();
export type Grant = z.infer<typeof grantSchema>;

// ── ArtifactReference ────────────────────────────────────────────────────────

export const artifactKindSchema = z.enum(["input", "context", "evidence", "output"]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactReferenceSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  runId: idSchema.nullable(),
  uri: z.string().min(1).max(2048),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  kind: artifactKindSchema,
  bytes: z.number().int().nonnegative(),
  mime: z.string().min(1).max(256),
  importedAt: timestampSchema,
  expiresAt: timestampSchema.nullable(),
}).strict();
export type ArtifactReference = z.infer<typeof artifactReferenceSchema>;

// ── AttentionItem ────────────────────────────────────────────────────────────

export const attentionKindSchema = z.enum(["decision", "conflict", "review", "stop"]);
export type AttentionKind = z.infer<typeof attentionKindSchema>;

export const attentionStateSchema = z.enum(["new", "seen", "snoozed", "dismissed", "resolved"]);
export type AttentionState = z.infer<typeof attentionStateSchema>;

export const attentionItemSchema = z.object({
  id: idSchema,
  taskId: idSchema.nullable(),
  kind: attentionKindSchema,
  issueIdentity: z.string().min(1).max(256),
  revision: z.number().int().min(0).max(1024),
  state: attentionStateSchema,
  payloadJson: z.string().max(64 * 1024),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type AttentionItem = z.infer<typeof attentionItemSchema>;
