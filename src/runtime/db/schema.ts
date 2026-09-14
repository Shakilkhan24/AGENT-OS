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
      description TEXT NOT NULL DEFAULT '',
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
      command TEXT NOT NULL,
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
      updated_at TEXT NOT NULL
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
