/**
 * M2.1 entity schema for the bounded control-state database.
 *
 * Each entry is the SQL `CREATE TABLE` statement plus the row schema used
 * to validate results returned from the driver. Foreign keys and uniqueness
 * constraints are encoded in SQL; their enforcement is exercised by the
 * "import + activate" tests (M2.4) and the "validate import" tests (M2.4).
 *
 * The schema is intentionally minimal: state + audit event + dispatch intent
 * commit together. Drafts, settings and tombstones are entity tables; the
 * control protocol is the only path that mutates them.
 */

import { z } from "zod";
import { presetSchema } from "../../shared/models";
import { envProfileSchema } from "../../shared/env-profiles";
import { hookSchema } from "../../shared/hooks";
import { launchRecordSchema } from "../../shared/models";
import { domainEventSchema } from "../../shared/events";
import { draftSummarySchema } from "../../shared/drafts";
import {
  artifactReferenceSchema,
  attentionItemSchema,
  contextReceiptSchema,
  dispatchIntentSchema,
  grantSchema,
  invocationSchema,
  leaseSchema,
  runSchema,
  taskSchema,
  workspaceSchema,
} from "../../shared/managed";

/** SQLite's `INTEGER PRIMARY KEY` rowid column. */
const rowId = "id INTEGER PRIMARY KEY AUTOINCREMENT";
const uuidColumn = "uuid TEXT NOT NULL UNIQUE";

export interface TableSpec {
  /** Logical entity name; must be a stable identifier used in audits. */
  readonly name: string;
  /** DDL statement. Use only portable SQLite types. */
  readonly ddl: string;
  /** Indices created alongside the table. */
  readonly indices: readonly string[];
}

export const SCHEMA_VERSION = 1;

/**
 * DDL statements. Designed for `node:sqlite` (and our in-memory driver); all
 * foreign-key and uniqueness rules are encoded declaratively so the engine
 * can enforce them without bespoke code paths.
 */
export const tableSpecs: readonly TableSpec[] = [
  {
    name: "session",
    ddl: `CREATE TABLE session (
      ${rowId},
      uuid TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      directory TEXT NOT NULL,
      identity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleting INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      deletion_policy TEXT
    )`,
    indices: ["CREATE INDEX session_uuid_idx ON session(uuid)"],
  },
  {
    name: "terminal",
    ddl: `CREATE TABLE terminal (
      ${rowId},
      ${uuidColumn},
      session_id INTEGER NOT NULL REFERENCES session(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      cwd TEXT NOT NULL,
      command TEXT NOT NULL,
      created_at TEXT NOT NULL,
      deleting INTEGER NOT NULL DEFAULT 0,
      deletion_policy TEXT,
      launch_error TEXT,
      started_at TEXT,
      ended_at TEXT,
      exit_signal TEXT,
      exit_code INTEGER,
      metadata_json TEXT,
      env_json TEXT,
      env_profile_id TEXT,
      prompt_anchors_json TEXT,
      launch_state TEXT,
      origin_hook_id TEXT
    )`,
    indices: [
      "CREATE INDEX terminal_session_idx ON terminal(session_id)",
      "CREATE INDEX terminal_uuid_idx ON terminal(uuid)",
    ],
  },
  {
    name: "preset",
    ddl: `CREATE TABLE preset (
      ${rowId},
      ${uuidColumn},
      name TEXT NOT NULL,
      command TEXT NOT NULL
    )`,
    indices: ["CREATE INDEX preset_uuid_idx ON preset(uuid)"],
  },
  {
    name: "env_profile",
    ddl: `CREATE TABLE env_profile (
      ${rowId},
      ${uuidColumn},
      name TEXT NOT NULL,
      variables_json TEXT NOT NULL DEFAULT '{}'
    )`,
    indices: ["CREATE INDEX env_profile_uuid_idx ON env_profile(uuid)"],
  },
  {
    name: "hook",
    ddl: `CREATE TABLE hook (
      ${rowId},
      ${uuidColumn},
      name TEXT NOT NULL,
      event TEXT NOT NULL,
      action_json TEXT NOT NULL,
      session_uuid TEXT,
      terminal_uuid TEXT,
      match TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
    )`,
    indices: ["CREATE INDEX hook_uuid_idx ON hook(uuid)"],
  },
  {
    name: "launch",
    ddl: `CREATE TABLE launch (
      ${rowId},
      ${uuidColumn},
      session_uuid TEXT NOT NULL REFERENCES session(uuid) ON DELETE CASCADE,
      key TEXT,
      fingerprint TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      terminal_uuids_json TEXT NOT NULL,
      state TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT NOT NULL DEFAULT '[]'
    )`,
    indices: [
      "CREATE INDEX launch_session_idx ON launch(session_uuid)",
      "CREATE INDEX launch_uuid_idx ON launch(uuid)",
      "CREATE UNIQUE INDEX launch_session_key_idx ON launch(session_uuid, key) WHERE key IS NOT NULL",
    ],
  },
  {
    name: "event",
    ddl: `CREATE TABLE event (
      seq INTEGER PRIMARY KEY,
      at TEXT NOT NULL,
      correlation_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      session_uuid TEXT,
      terminal_uuid TEXT,
      origin_hook_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX event_session_idx ON event(session_uuid)",
      "CREATE INDEX event_terminal_idx ON event(terminal_uuid)",
      "CREATE INDEX event_type_idx ON event(type)",
    ],
  },
  {
    name: "draft",
    ddl: `CREATE TABLE draft (
      id TEXT PRIMARY KEY,
      session_uuid TEXT NOT NULL REFERENCES session(uuid) ON DELETE CASCADE,
      path TEXT NOT NULL,
      base_hash TEXT NOT NULL,
      content TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL,
      root_identity TEXT NOT NULL DEFAULT ''
    )`,
    indices: [
      "CREATE INDEX draft_session_idx ON draft(session_uuid)",
      "CREATE UNIQUE INDEX draft_session_path_idx ON draft(session_uuid, path)",
    ],
  },
  {
    name: "meta",
    ddl: `CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`,
    indices: [],
  },
  {
    name: "task",
    ddl: `CREATE TABLE task (
      ${rowId},
      ${uuidColumn},
      title TEXT NOT NULL,
      objective TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      project_id TEXT NOT NULL DEFAULT '',
      provider_version TEXT,
      model TEXT,
      account_mode TEXT,
      host_id TEXT NOT NULL DEFAULT '',
      base_identity TEXT,
      root_identity TEXT,
      effective_inputs_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX task_status_idx ON task(status)",
      "CREATE INDEX task_project_idx ON task(project_id)",
    ],
  },
  {
    name: "run",
    ddl: `CREATE TABLE run (
      ${rowId},
      ${uuidColumn},
      task_id TEXT NOT NULL REFERENCES task(uuid) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at TEXT,
      ended_at TEXT,
      base_revision TEXT,
      terminal_uuid TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX run_task_idx ON run(task_id)",
      "CREATE INDEX run_status_idx ON run(status)",
    ],
  },
  {
    name: "invocation",
    ddl: `CREATE TABLE invocation (
      ${rowId},
      ${uuidColumn},
      run_id TEXT NOT NULL REFERENCES run(uuid) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      idempotency_key TEXT NOT NULL,
      canonical_digest TEXT NOT NULL,
      provider_version TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      account_mode TEXT NOT NULL DEFAULT 'anonymous',
      started_at TEXT,
      ended_at TEXT,
      created_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX invocation_run_idx ON invocation(run_id)",
      "CREATE UNIQUE INDEX invocation_idem_idx ON invocation(run_id, idempotency_key)",
    ],
  },
  {
    name: "dispatch_intent",
    ddl: `CREATE TABLE dispatch_intent (
      ${rowId},
      ${uuidColumn},
      run_id TEXT NOT NULL REFERENCES run(uuid) ON DELETE CASCADE,
      invocation_id TEXT,
      method TEXT NOT NULL,
      args_json TEXT NOT NULL DEFAULT '{}',
      scope_json TEXT NOT NULL DEFAULT '{}',
      deadline_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'recorded',
      created_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX dispatch_intent_run_idx ON dispatch_intent(run_id)",
      "CREATE INDEX dispatch_intent_state_idx ON dispatch_intent(state)",
    ],
  },
  {
    name: "workspace",
    ddl: `CREATE TABLE workspace (
      ${rowId},
      ${uuidColumn},
      task_id TEXT NOT NULL REFERENCES task(uuid) ON DELETE CASCADE,
      kind TEXT NOT NULL DEFAULT 'snapshot',
      location TEXT NOT NULL,
      base_identity TEXT,
      worktree_path TEXT,
      head_revision TEXT,
      lease_id TEXT,
      created_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX workspace_task_idx ON workspace(task_id)",
    ],
  },
  {
    name: "grant",
    ddl: `CREATE TABLE grant (
      ${rowId},
      ${uuidColumn},
      task_id TEXT,
      kind TEXT NOT NULL DEFAULT 'authority',
      scope_json TEXT NOT NULL DEFAULT '{}',
      principal TEXT NOT NULL DEFAULT '',
      digests_json TEXT NOT NULL DEFAULT '{}',
      state TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT
    )`,
    indices: [
      "CREATE INDEX grant_task_idx ON grant(task_id)",
      "CREATE INDEX grant_state_idx ON grant(state)",
    ],
  },
  {
    name: "artifact_reference",
    ddl: `CREATE TABLE artifact_reference (
      ${rowId},
      ${uuidColumn},
      task_id TEXT,
      run_id TEXT,
      uri TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'context',
      bytes INTEGER NOT NULL DEFAULT 0,
      mime TEXT NOT NULL DEFAULT '',
      imported_at TEXT NOT NULL,
      expires_at TEXT
    )`,
    indices: [
      "CREATE INDEX artifact_task_idx ON artifact_reference(task_id)",
      "CREATE INDEX artifact_run_idx ON artifact_reference(run_id)",
      "CREATE UNIQUE INDEX artifact_uri_sha_idx ON artifact_reference(uri, sha256)",
    ],
  },
  {
    name: "attention_item",
    ddl: `CREATE TABLE attention_item (
      ${rowId},
      ${uuidColumn},
      task_id TEXT,
      kind TEXT NOT NULL DEFAULT 'decision',
      issue_identity TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'new',
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX attention_kind_idx ON attention_item(kind)",
      "CREATE INDEX attention_state_idx ON attention_item(state)",
      "CREATE UNIQUE INDEX attention_issue_idx ON attention_item(issue_identity, revision)",
    ],
  },
  {
    name: "lease",
    ddl: `CREATE TABLE lease (
      ${rowId},
      ${uuidColumn},
      workspace_id TEXT NOT NULL REFERENCES workspace(uuid) ON DELETE CASCADE,
      holder TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'held',
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      renewed_at TEXT,
      released_at TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0
    )`,
    indices: [
      "CREATE INDEX lease_workspace_idx ON lease(workspace_id)",
      "CREATE INDEX lease_state_idx ON lease(state)",
    ],
  },
  {
    name: "context_receipt",
    ddl: `CREATE TABLE context_receipt (
      ${rowId},
      ${uuidColumn},
      run_id TEXT NOT NULL REFERENCES run(uuid) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'draft',
      objective TEXT NOT NULL DEFAULT '',
      constraints_json TEXT NOT NULL DEFAULT '{}',
      acceptance_checks_json TEXT NOT NULL DEFAULT '{}',
      selected_revisions_json TEXT NOT NULL DEFAULT '{}',
      instructions_json TEXT NOT NULL DEFAULT '{}',
      environment_json TEXT NOT NULL DEFAULT '{}',
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      exclusions_json TEXT NOT NULL DEFAULT '{}',
      digests_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX receipt_run_idx ON context_receipt(run_id)",
      "CREATE INDEX receipt_status_idx ON context_receipt(status)",
      "CREATE UNIQUE INDEX receipt_run_idx ON context_receipt(run_id)",
    ],
  },
];

export const terminalRowSchema = z.object({
  uuid: z.string().uuid(),
  session_id: z.number().int(),
  label: z.string(),
  cwd: z.string(),
  command: z.string(),
  created_at: z.string(),
  deleting: z.union([z.literal(0), z.literal(1)]),
  deletion_policy: z.string().nullable(),
  launch_error: z.string().nullable(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  exit_signal: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  metadata_json: z.string().nullable(),
  env_json: z.string().nullable(),
  env_profile_id: z.string().nullable(),
  prompt_anchors_json: z.string().nullable(),
  launch_state: z.string().nullable(),
  origin_hook_id: z.string().nullable(),
});

export const sessionRowSchema = z.object({
  uuid: z.string().uuid(),
  name: z.string(),
  directory: z.string(),
  identity: z.string(),
  created_at: z.string(),
  deleting: z.union([z.literal(0), z.literal(1)]),
  metadata_json: z.string(),
  deletion_policy: z.string().nullable(),
});

export const presetRowSchema = presetSchema.extend({ uuid: z.string().uuid() });
export const envProfileRowSchema = envProfileSchema.extend({ uuid: z.string().uuid() });
export const hookRowSchema = hookSchema.extend({ uuid: z.string().uuid() });
export const launchRowSchema = launchRecordSchema.extend({ uuid: z.string().uuid(), session_uuid: z.string().uuid() });
export const eventRowSchema = domainEventSchema;
export const draftRowSchema = draftSummarySchema.extend({ revision: z.number().int().min(1) });

// M3a — managed-work row schemas. Each wraps the shared schema with the DB
// row's id (UUID) and the column → property renames the driver returns.
export const taskRowSchema = taskSchema.extend({ uuid: z.string().uuid() });
export const runRowSchema = runSchema.extend({ uuid: z.string().uuid() });
export const invocationRowSchema = invocationSchema.extend({ uuid: z.string().uuid() });
export const dispatchIntentRowSchema = dispatchIntentSchema.extend({ uuid: z.string().uuid() });
export const workspaceRowSchema = workspaceSchema.extend({ uuid: z.string().uuid() });
export const grantRowSchema = grantSchema.extend({ uuid: z.string().uuid() });
export const artifactReferenceRowSchema = artifactReferenceSchema.extend({ uuid: z.string().uuid() });
export const attentionItemRowSchema = attentionItemSchema.extend({ uuid: z.string().uuid() });
export const leaseRowSchema = leaseSchema.extend({ uuid: z.string().uuid() });
export const contextReceiptRowSchema = contextReceiptSchema.extend({ uuid: z.string().uuid() });
