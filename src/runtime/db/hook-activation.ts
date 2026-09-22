/**
 * M4.7.a — hook activation + authority gate.
 *
 * A hook is a registered definition (the M3 `hook` table rows). It
 * stays **inactive** until explicitly activated by an approved
 * authority grant. The activation row lives in the meta table under
 * `hook-activation:<hookId>`; absence is the authoritative "inactive"
 * state. The legacy `hook.enabled` column is *advisory* only —
 * imported hooks may say `enabled = 1` but are not active until this
 * module says so.
 *
 * The gate is enforced by:
 *  - `activateHook` writing a content-addressed row whose
 *    `payloadDigest` covers `(hookId, activatedBy,
 *    authorityGrantId, hookKind)` (timestamps excluded so
 *    re-activation with identical inputs produces an identical
 *    digest);
 *  - refusing activation without an `approved` `authority`
 *    grant whose `scope_json.hookKinds` covers the hook's
 *    `action.type`;
 *  - refusing self-activation: the activator principal must
 *    equal the grant's `decidedBy`, **never** the grant's
 *    `principal` (the existing anti-self-approval rule from
 *    `runtime/db/grants.ts`).
 *
 * The orchestrator (`runtime/orchestration/hook-execute.ts`)
 * consumes `isHookActive` / `listActiveHookIds` to gate firing.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";
import { hookSchema, type Hook } from "../../shared/hooks";
import { readGrant } from "./grants";

/**
 * Meta-table key prefix for hook activations. The full key is
 * `hook-activation:<hookId>` so a single hook has exactly one
 * activation row (absence ⇒ inactive).
 */
export const HOOK_ACTIVATION_META_PREFIX = "hook-activation:";

/** Scope key inside an `authority` grant's `scope_json`. */
export const HOOK_AUTHORITY_SCOPE_KEY = "hookKinds";

/** Action kinds a hook may carry. Mirrors `shared/hooks.ts`. */
export const HOOK_ACTION_KINDS = [
  "notify",
  "run-command-in-terminal",
  "open-file",
] as const;
export const hookActionKindSchema = z.enum(HOOK_ACTION_KINDS);
export type HookActionKind = z.infer<typeof hookActionKindSchema>;

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

/**
 * Persisted activation record. `payloadDigest` excludes
 * `activatedAt` so identical re-activations produce identical
 * digests (drift detection compares authority, not capture
 * moment).
 */
export interface HookActivationRecord {
  readonly hookId: string;
  readonly activatedBy: string;
  readonly authorityGrantId: string;
  readonly hookKind: HookActionKind;
  readonly activatedAt: string;
  readonly payloadDigest: string;
}

export const hookActivationRecordSchema = z
  .object({
    hookId: z.string().uuid(),
    activatedBy: z.string().min(1).max(256),
    authorityGrantId: z.string().uuid(),
    hookKind: hookActionKindSchema,
    activatedAt: z.string().datetime(),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type HookActivationRecordParsed = z.infer<typeof hookActivationRecordSchema>;

/** Build the meta key for a hook activation row. */
export function activationKey(hookId: string): string {
  return `${HOOK_ACTIVATION_META_PREFIX}${hookId}`;
}

/** Build the canonical digest for a HookActivationRecord. */
export function digestActivation(input: {
  hookId: string;
  activatedBy: string;
  authorityGrantId: string;
  hookKind: HookActionKind;
}): string {
  return createHash("sha256")
    .update(stableStringify({ ...input, payloadDigest: "" }), "utf8")
    .digest("hex");
}

/**
 * Read the hook row by id. The M3 `hook` table has no service
 * helper; we keep this small reader inline rather than introducing
 * a full `runtime/db/hooks.ts` for M4.7.
 */
export async function readHookRow(
  worker: DbWorker,
  hookId: string,
): Promise<Hook | undefined> {
  const driver = driverOf(worker);
  const row = driver
    .prepare(
      "SELECT uuid, name, event, session_uuid, terminal_uuid, match, " +
      "action_json, enabled FROM hook WHERE uuid = ?",
    )
    .first(hookId);
  if (!row) return undefined;
  let action: unknown;
  try {
    action = JSON.parse(String(row.action_json ?? "{}"));
  } catch {
    return undefined;
  }
  const parsed = hookSchema.safeParse({
    id: String(row.uuid),
    name: String(row.name),
    enabled: Number(row.enabled ?? 0) === 1,
    event: String(row.event),
    sessionId: row.session_uuid == null ? undefined : String(row.session_uuid),
    terminalId: row.terminal_uuid == null ? undefined : String(row.terminal_uuid),
    match: row.match == null ? undefined : String(row.match),
    action,
  });
  if (!parsed.success) return undefined;
  return parsed.data;
}

const activateSchema = z
  .object({
    hookId: z.string().uuid(),
    principal: z.string().min(1).max(256),
    authorityGrantId: z.string().uuid(),
  })
  .strict();
export type ActivateHookInput = z.input<typeof activateSchema>;

/**
 * Activate a hook. Refuses with `NOT_FOUND` for an unknown
 * hookId; refuses with `FORBIDDEN` if the supplied authority
 * grant is missing, not `approved`, doesn't cover the hook's
 * `action.type` in `scope_json.hookKinds`, or is self-approved
 * (activator principal must equal the grant's `decidedBy`,
 * never its `principal`).
 */
export async function activateHook(
  worker: DbWorker,
  input: ActivateHookInput,
): Promise<HookActivationRecord> {
  let parsed: z.infer<typeof activateSchema>;
  try {
    parsed = activateSchema.parse(input);
  } catch (error) {
    throw new AppError("INVALID_REQUEST",
      error instanceof z.ZodError ? error.message : String(error));
  }
  const hook = await readHookRow(worker, parsed.hookId);
  if (!hook) throw new AppError("NOT_FOUND", `Hook ${parsed.hookId} not found`);

  const hookKind = hookActionKindSchema.safeParse(hook.action.type);
  if (!hookKind.success) {
    // The M3 hook schema constrains `action.type` to one of three
    // literals, so this should be unreachable. Guard anyway: a
    // future hook-schema change must not silently allow an
    // unrecognised action kind through the activation gate.
    throw new AppError("INVALID_REQUEST",
      `Hook action type "${hook.action.type}" is not a recognised hook kind`);
  }

  const grant = await readGrant(worker, parsed.authorityGrantId);
  if (!grant) throw new AppError("FORBIDDEN",
    `Authority grant ${parsed.authorityGrantId} not found`);
  if (grant.kind !== "authority") throw new AppError("FORBIDDEN",
    `Grant ${parsed.authorityGrantId} is "${grant.kind}", not "authority"`);
  if (grant.state !== "approved") throw new AppError("FORBIDDEN",
    `Grant ${parsed.authorityGrantId} is in state "${grant.state}" (must be "approved")`);
  if (grant.decidedBy == null) throw new AppError("FORBIDDEN",
    `Grant ${parsed.authorityGrantId} has no decidedBy principal`);
  if (parsed.principal === grant.principal) throw new AppError("FORBIDDEN",
    `Self-activation refused: principal equals grant's requester principal`);
  if (parsed.principal !== grant.decidedBy) throw new AppError("FORBIDDEN",
    `Activator principal must equal the grant's decidedBy principal`);

  let scope: { hookKinds?: unknown } = {};
  try {
    const parsedScope = JSON.parse(grant.scopeJson) as { hookKinds?: unknown };
    if (parsedScope && typeof parsedScope === "object" && !Array.isArray(parsedScope))
      scope = parsedScope;
  } catch {
    scope = {};
  }
  const hookKindsRaw = scope.hookKinds;
  if (!Array.isArray(hookKindsRaw) || !hookKindsRaw.includes(hookKind.data)) {
    throw new AppError("FORBIDDEN",
      `Authority grant ${parsed.authorityGrantId} scope_json.hookKinds ` +
      `does not include "${hookKind.data}"`);
  }

  const activatedAt = new Date().toISOString();
  const payloadDigest = digestActivation({
    hookId: parsed.hookId,
    activatedBy: parsed.principal,
    authorityGrantId: parsed.authorityGrantId,
    hookKind: hookKind.data,
  });
  const record = hookActivationRecordSchema.parse({
    hookId: parsed.hookId,
    activatedBy: parsed.principal,
    authorityGrantId: parsed.authorityGrantId,
    hookKind: hookKind.data,
    activatedAt,
    payloadDigest,
  });

  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ).run(activationKey(parsed.hookId), JSON.stringify(record));
  });
  return record;
}

const deactivateSchema = z
  .object({
    hookId: z.string().uuid(),
    principal: z.string().min(1).max(256),
  })
  .strict();
export type DeactivateHookInput = z.input<typeof deactivateSchema>;

export interface HookDeactivationReceipt {
  readonly hookId: string;
  readonly deactivatedAt: string;
  readonly payloadDigest: string;
}

/**
 * Deactivate a hook by deleting the activation row. The absence
 * of the row is the authoritative "inactive" state, so there
 * is no tombstone. Idempotent: removing an absent row returns
 * a receipt with `payloadDigest: ""`.
 */
export async function deactivateHook(
  worker: DbWorker,
  input: DeactivateHookInput,
): Promise<HookDeactivationReceipt> {
  let parsed: z.infer<typeof deactivateSchema>;
  try {
    parsed = deactivateSchema.parse(input);
  } catch (error) {
    throw new AppError("INVALID_REQUEST",
      error instanceof z.ZodError ? error.message : String(error));
  }
  const driver = driverOf(worker);
  const key = activationKey(parsed.hookId);
  let existed = false;
  await worker.transaction(tx => {
    void tx;
    const existing = driver.prepare("SELECT value FROM meta WHERE key = ?").first(key);
    existed = !!existing;
    driver.prepare("DELETE FROM meta WHERE key = ?").run(key);
  });
  const deactivatedAt = new Date().toISOString();
  // Receipt digest covers the *act* of deactivation (hookId +
  // principal + deactivatedAt). Empty digest ⇒ hook was already
  // inactive; callers can detect idempotent no-ops via that.
  const payloadDigest = existed
    ? createHash("sha256")
        .update(stableStringify({
          hookId: parsed.hookId,
          principal: parsed.principal,
          deactivatedAt,
          payloadDigest: "",
        }), "utf8")
        .digest("hex")
    : "";
  return { hookId: parsed.hookId, deactivatedAt, payloadDigest };
}

/**
 * Test seam: read the activation row for a hook. Returns
 * `undefined` when the hook is inactive.
 */
export async function readHookActivation(
  worker: DbWorker,
  hookId: string,
): Promise<HookActivationRecord | undefined> {
  const driver = driverOf(worker);
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?")
    .first(activationKey(hookId));
  if (!row) return undefined;
  try {
    return hookActivationRecordSchema.parse(JSON.parse(String(row.value)));
  } catch {
    return undefined;
  }
}

/**
 * Authoritative activation gate: `true` iff an activation row
 * exists for the hookId. Absence ⇒ inactive.
 */
export async function isHookActive(
  worker: DbWorker,
  hookId: string,
): Promise<boolean> {
  const record = await readHookActivation(worker, hookId);
  return record !== undefined;
}

/**
 * List all currently-activated hook ids. The set is the
 * authoritative gate for the orchestrator — only hooks in this
 * set can be fired. Implementation scans all meta rows and
 * filters by key prefix client-side: the in-memory test
 * driver does not support `LIKE`, and the row count is small
 * enough that a full scan is acceptable.
 */
export async function listActiveHookIds(worker: DbWorker): Promise<ReadonlyArray<string>> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT key, value FROM meta").all();
  const ids: string[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(HOOK_ACTIVATION_META_PREFIX)) continue;
    try {
      const parsed = hookActivationRecordSchema.parse(JSON.parse(String(row.value)));
      ids.push(parsed.hookId);
    } catch {
      // Malformed activation row — skip. The orchestrator's
      // `isHookActive` is the source of truth, so a skipped
      // row simply means "this hook is inactive".
    }
  }
  return ids;
}
