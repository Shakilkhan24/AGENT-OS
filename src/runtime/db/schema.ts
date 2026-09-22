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
  reviewSchema,
  runSchema,
  taskSchema,
  verificationRecipeSchema,
  verificationSchema,
  workspaceSchema,
} from "../../shared/managed";

/** SQLite's `INTEGER PRIMARY KEY` rowid column. */
const rowId = "id INTEGER PRIMARY KEY AUTOINCREMENT";
const uuidColumn = "uuid TEXT NOT NULL UNIQUE";

/** M6.4 schema-version: bumped to introduce the `owner_identity`
 *  column on `workflow_run` so durable workflow execution can
 *  revalidate ownership before continuation. Older workers refuse
 *  to open a DB tagged with a newer SCHEMA_VERSION. */
export const SCHEMA_VERSION = 6;

export interface TableSpec {
  /** Logical entity name; must be a stable identifier used in audits. */
  readonly name: string;
  /** DDL statement. Use only portable SQLite types. */
  readonly ddl: string;
  /** Indices created alongside the table. */
  readonly indices: readonly string[];
}

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
      ended_reason TEXT,
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
      claimed_at TEXT,
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
      updated_at TEXT NOT NULL,
      snoozed_until TEXT
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
      "CREATE INDEX receipt_status_idx ON context_receipt(status)",
      "CREATE UNIQUE INDEX receipt_run_unique_idx ON context_receipt(run_id)",
    ],
  },
  // M3c.2 — verifier executor + review-binding. Recipes live per-project;
  // a verification records one execution of a recipe (or a one-off
  // command override); a review is the acceptance state machine bound to
  // (candidate identity triple, configuration revision, evidence ids).
  {
    name: "verification_recipe",
    ddl: `CREATE TABLE verification_recipe (
      ${rowId},
      ${uuidColumn},
      project_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      command TEXT NOT NULL,
      argv_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      assertion_pattern TEXT,
      required INTEGER NOT NULL DEFAULT 1,
      configuration_revision TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX verification_recipe_project_idx ON verification_recipe(project_id)",
    ],
  },
  {
    name: "verification",
    ddl: `CREATE TABLE verification (
      ${rowId},
      ${uuidColumn},
      task_id TEXT,
      run_id TEXT,
      recipe_id TEXT,
      command TEXT NOT NULL,
      cwd TEXT NOT NULL,
      argv_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      configuration_revision TEXT,
      candidate_base TEXT,
      candidate_tree TEXT,
      candidate_diff TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      exit_code INTEGER,
      signal TEXT,
      started_at TEXT,
      ended_at TEXT,
      assertion_counts_json TEXT,
      required_check_results_json TEXT NOT NULL DEFAULT '[]',
      stdout_tail_json TEXT NOT NULL DEFAULT '""',
      stderr_tail_json TEXT NOT NULL DEFAULT '""',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX verification_task_idx ON verification(task_id)",
      "CREATE INDEX verification_run_idx ON verification(run_id)",
      "CREATE INDEX verification_status_idx ON verification(status)",
    ],
  },
  {
    name: "review",
    ddl: `CREATE TABLE review (
      ${rowId},
      ${uuidColumn},
      task_id TEXT,
      run_id TEXT,
      evidence_verification_ids_json TEXT NOT NULL DEFAULT '[]',
      candidate_base TEXT,
      candidate_tree TEXT,
      candidate_diff TEXT,
      configuration_revision TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      decision TEXT,
      decided_by TEXT,
      decision_note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX review_task_idx ON review(task_id)",
      "CREATE INDEX review_run_idx ON review(run_id)",
      "CREATE INDEX review_status_idx ON review(status)",
    ],
  },
  // M6.4 — durable workflow execution state. A `workflow_run` row is
  // inserted by `runWorkflow` BEFORE any step is dispatched so a crash
  // during the run is recoverable: the `resumeWorkflow` function
  // walks the persisted graph + completed step outputs and continues
  // from the next ready step. Cancellation intent is written to
  // `cancel_requested_at`; the executor observes it on the next tick.
  //
  // `owner_identity` captures the principal authorized to continue
  // the run (e.g. workspace session identity, user identity for the
  // active profile). On resume, the supplied `ownerIdentity` MUST
  // match the persisted value — this is the "revalidate before
  // continuation" gate from the M6.4 spec.
  {
    name: "workflow_run",
    ddl: `CREATE TABLE workflow_run (
      ${rowId},
      ${uuidColumn},
      workflow_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT NOT NULL DEFAULT '',
      owner_identity TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
      graph_json TEXT NOT NULL,
      cancel_requested_at TEXT,
      cancel_requested_by TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      terminal_outcome TEXT,
      audit_digest TEXT
    )`,
    indices: [
      "CREATE INDEX workflow_run_status_idx ON workflow_run(status)",
    ],
  },
  // M6.4 — per-step output. Persisted BEFORE the step's `remaining`
  // entry is removed so a crash between commit and the next dispatch
  // cannot lose the output. The `output_digest` is the SHA-256 over
  // the canonical JSON of `output_json`, mirroring the audit-event
  // digest surface so two outputs with the same shape compare equal.
  {
    name: "workflow_step_output",
    ddl: `CREATE TABLE workflow_step_output (
      ${rowId},
      ${uuidColumn},
      workflow_run_uuid TEXT NOT NULL REFERENCES workflow_run(uuid) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      output_json TEXT NOT NULL,
      output_digest TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE UNIQUE INDEX workflow_step_output_run_step_idx ON workflow_step_output(workflow_run_uuid, step_id)",
    ],
  },
  // M6.4 — per-step durable state. Carries:
  //   - `state`         running | waiting | completed | failed | cancelled
  //   - `wake_at`        for `wait` and `approval` steps, the wall-clock
  //                       timestamp at which the executor may resume;
  //   - `failure_json`   populated on terminal `failed` / `cancelled`;
  // The combination of (run_uuid, step_id) is unique so a resume
  // upserts and never collides.
  {
    name: "workflow_step_state",
    ddl: `CREATE TABLE workflow_step_state (
      ${rowId},
      ${uuidColumn},
      workflow_run_uuid TEXT NOT NULL REFERENCES workflow_run(uuid) ON DELETE CASCADE,
      step_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'running',
      dispatched_at TEXT,
      wake_at TEXT,
      failure_json TEXT,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE UNIQUE INDEX workflow_step_state_run_step_idx ON workflow_step_state(workflow_run_uuid, step_id)",
      "CREATE INDEX workflow_step_state_state_idx ON workflow_step_state(state)",
    ],
  },
  // M7 — durable schedule layer. Three tables:
  //   - `schedule`              — one row per schedule identity;
  //   - `schedule_revision`     — one row per rule/recipe/tz revision;
  //   - `schedule_occurrence`   — one row per intended firing,
  //                                unique on `(schedule_id, revision,
  //                                intended_utc)`.
  // The dispatcher (`fireDueOccurrences`) reads pending rows with
  // `intended_utc <= now`, transitions them to `dispatched`, and
  // hands the recipe id to the workflow executor.
  {
    name: "schedule",
    ddl: `CREATE TABLE schedule (
      ${rowId},
      ${uuidColumn},
      schedule_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      timezone TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      grace_window_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'enabled',
      host_id TEXT NOT NULL DEFAULT '',
      tzdata_version TEXT NOT NULL DEFAULT '',
      boot_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    indices: [
      "CREATE INDEX schedule_status_idx ON schedule(status)",
    ],
  },
  {
    name: "schedule_revision",
    ddl: `CREATE TABLE schedule_revision (
      ${rowId},
      ${uuidColumn},
      schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      rule_json TEXT NOT NULL,
      timezone TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      grace_window_ms INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft',
      revision_digest TEXT NOT NULL,
      published_at TEXT NOT NULL,
      published_by TEXT NOT NULL DEFAULT '',
      host_id TEXT NOT NULL DEFAULT ''
    )`,
    indices: [
      "CREATE UNIQUE INDEX schedule_revision_id_rev_idx ON schedule_revision(schedule_id, revision)",
      "CREATE INDEX schedule_revision_status_idx ON schedule_revision(status)",
    ],
  },
  {
    name: "schedule_occurrence",
    ddl: `CREATE TABLE schedule_occurrence (
      ${rowId},
      ${uuidColumn},
      schedule_id TEXT NOT NULL REFERENCES schedule(schedule_id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      intended_utc TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      local_time_iso TEXT,
      timezone_data_version TEXT,
      dispatched_at TEXT,
      workflow_run_uuid TEXT,
      boot_id TEXT NOT NULL DEFAULT '',
      coalesced_with TEXT,
      dispatch_state TEXT NOT NULL DEFAULT 'pending'
    )`,
    indices: [
      "CREATE UNIQUE INDEX schedule_occurrence_unique_idx ON schedule_occurrence(schedule_id, revision, intended_utc)",
      "CREATE INDEX schedule_occurrence_state_idx ON schedule_occurrence(state)",
      "CREATE INDEX schedule_occurrence_intended_idx ON schedule_occurrence(intended_utc)",
      "CREATE INDEX schedule_occurrence_dispatch_state_idx ON schedule_occurrence(dispatch_state)",
      "CREATE INDEX schedule_occurrence_boot_id_idx ON schedule_occurrence(boot_id)",
    ],
  },
  // -----------------------------------------------------------------
  // M7.3 — occurrence state transition audit log
  //
  // One row per state move on a `schedule_occurrence` row. Records
  // both wall-clock ISO timestamp AND the monotonic-ms since the
  // boot's basis so audit readers can confirm "this row was moved
  // during boot X". Indexed by `occurrence_id` + `recorded_at`.
  // -----------------------------------------------------------------
  {
    name: "occurrence_state_transition",
    ddl: `CREATE TABLE occurrence_state_transition (
      ${rowId},
      ${uuidColumn},
      occurrence_uuid TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      monotonic_ms_since_boot INTEGER NOT NULL,
      wall_clock_iso TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      recorded_by TEXT NOT NULL DEFAULT ''
    )`,
    indices: [
      "CREATE INDEX occurrence_state_transition_occurrence_idx ON occurrence_state_transition(occurrence_uuid)",
      "CREATE INDEX occurrence_state_transition_wall_clock_idx ON occurrence_state_transition(wall_clock_iso)",
    ],
  },
  // -----------------------------------------------------------------
  // M8 — owned remote execution
  // -----------------------------------------------------------------
  //   - `owned_remote_host`    — one row per SSH host identity.
  //   - `owned_remote_session` — a prepared session for a host.
  //   - `owned_remote_receipt` — a per-host install / capability receipt.
  //   - `owned_remote_invoke`  — a remote invocation record (mirrors
  //                              workflow_run for the remote path).
  {
    name: "owned_remote_host",
    ddl: `CREATE TABLE owned_remote_host (
      ${rowId},
      ${uuidColumn},
      host_id TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      ssh_target TEXT NOT NULL,
      host_key_fingerprint TEXT NOT NULL,
      auth_kind TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      last_probed_at TEXT,
      last_probed_runtime TEXT,
      registered_at TEXT NOT NULL,
      registered_by TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reachable',
    )`,
    indices: [
      "CREATE INDEX owned_remote_host_status_idx ON owned_remote_host(status)",
    ],
  },
  {
    name: "owned_remote_session",
    ddl: `CREATE TABLE owned_remote_session (
      ${rowId},
      ${uuidColumn},
      host_id TEXT NOT NULL REFERENCES owned_remote_host(host_id) ON DELETE CASCADE,
      handle_id TEXT NOT NULL UNIQUE,
      pin_digest TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      prepared_at TEXT NOT NULL,
      last_observed_at TEXT,
      last_observed_runtime TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
    )`,
    indices: [
      "CREATE INDEX owned_remote_session_host_idx ON owned_remote_session(host_id)",
      "CREATE INDEX owned_remote_session_status_idx ON owned_remote_session(status)",
    ],
  },
  {
    name: "owned_remote_receipt",
    ddl: `CREATE TABLE owned_remote_receipt (
      ${rowId},
      ${uuidColumn},
      host_id TEXT NOT NULL REFERENCES owned_remote_host(host_id) ON DELETE CASCADE,
      receipt_kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      digest TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      recorded_by TEXT NOT NULL,
      detail_json TEXT,
    )`,
    indices: [
      "CREATE INDEX owned_remote_receipt_host_idx ON owned_remote_receipt(host_id)",
    ],
  },
  {
    name: "owned_remote_invoke",
    ddl: `CREATE TABLE owned_remote_invoke (
      ${rowId},
      ${uuidColumn},
      host_id TEXT NOT NULL REFERENCES owned_remote_host(host_id) ON DELETE CASCADE,
      handle_id TEXT NOT NULL,
      recipe_id TEXT NOT NULL,
      recipe_version INTEGER NOT NULL,
      invocation_id TEXT NOT NULL UNIQUE,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'in-flight',
      last_observed_at TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      remote_state TEXT,
      remote_exit_code INTEGER,
      remote_stderr_tail TEXT,
    )`,
    indices: [
      "CREATE INDEX owned_remote_invoke_host_idx ON owned_remote_invoke(host_id)",
      "CREATE INDEX owned_remote_invoke_status_idx ON owned_remote_invoke(status)",
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

// M3c.2 — verifier executor + review binding row schemas. Each row carries
// its UUID as the public `id`; the column → property renames mirror the
// existing M3a/M3b tables. `required` flips to/from a 0/1 INTEGER.
// `configurationRevision` is the SHA-256 of the recipe at last write; it
// is what binds a review to "the configuration revision the user accepted".
export const verificationRecipeRowSchema = verificationRecipeSchema.extend({ uuid: z.string().uuid() });
export const verificationRowSchema = verificationSchema.extend({ uuid: z.string().uuid() });
export const reviewRowSchema = reviewSchema.extend({ uuid: z.string().uuid() });

// M6.4 — workflow run row schemas. These mirror the SQL column layout
// (snake_case) so the helpers in `src/runtime/db/workflow-runs.ts`
// can map rows directly without an additional renames pass.
export const workflowRunRowSchema = z
  .object({
    uuid: z.string().uuid(),
    workflow_id: z.string().min(1).max(128),
    status: z.enum(["running", "completed", "failed", "cancelled"]),
    created_by: z.string().min(0).max(256),
    owner_identity: z.string().min(0).max(256),
    settings_json: z.string(),
    graph_json: z.string(),
    cancel_requested_at: z.string().nullable(),
    cancel_requested_by: z.string().nullable(),
    started_at: z.string().datetime(),
    ended_at: z.string().datetime().nullable(),
    terminal_outcome: z.enum(["completed", "failed", "cancelled"]).nullable(),
    audit_digest: z.string().nullable(),
  })
  .strict();
export type WorkflowRunRow = z.infer<typeof workflowRunRowSchema>;

export const workflowStepOutputRowSchema = z
  .object({
    uuid: z.string().uuid(),
    workflow_run_uuid: z.string().uuid(),
    step_id: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    output_json: z.string(),
    output_digest: z.string().regex(/^[0-9a-f]{64}$/),
    completed_at: z.string().datetime(),
  })
  .strict();
export type WorkflowStepOutputRow = z.infer<typeof workflowStepOutputRowSchema>;

export const workflowStepStateRowSchema = z
  .object({
    uuid: z.string().uuid(),
    workflow_run_uuid: z.string().uuid(),
    step_id: z.string().min(1).max(128),
    kind: z.string().min(1).max(64),
    state: z.enum(["running", "waiting", "completed", "failed", "cancelled"]),
    dispatched_at: z.string().datetime().nullable(),
    wake_at: z.string().datetime().nullable(),
    failure_json: z.string().nullable(),
    updated_at: z.string().datetime(),
  })
  .strict();
export type WorkflowStepStateRow = z.infer<typeof workflowStepStateRowSchema>;
