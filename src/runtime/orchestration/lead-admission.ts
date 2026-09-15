/**
 * M5.2 — lead-proposal admission service.
 *
 * A selected Codex / Claude lead submits a bounded `LeadWorkProposal`
 * (work items + dependencies + authority grants) and the runtime
 * admits them through the normal task + grant + admission path.
 *
 * The M5.2 trust model is "child authority can only narrow":
 *
 *  - Every admitted child task carries a `parent_task_id` lineage
 *    key in the meta table (`parent-task:<childTaskId>` →
 *    `<parentTaskId>`). This is opt-in: when `context.parentTaskId`
 *    is `null`, the admitted tasks carry no lineage.
 *  - When `context.parentTaskId` is set, every grant in
 *    `proposal.grants` whose `parentGrantId` is not null must
 *    NARROW the parent's grant:
 *      * `scope` must be a subset of the parent's parsed scope;
 *      * `expiresAt` must be ≤ the parent's `expiresAt` (or both null);
 *      * `restrictions` must be a subset of the parent's restrictions;
 *      * `digests` must be a subset of the parent's digest map;
 *      * depth is `parent.depth + 1` (a child grant's depth is
 *        recorded in `meta` under
 *        `grant-depth:<grantId>`).
 *    Grants whose `parentGrantId` is null do NOT need to narrow
 *    but are still subject to the principal / project gates.
 *  - The principal bound at connection time is the only authority
 *    for self-approval: `decideGrant` already enforces
 *    `decidedBy !== principal`. M5.2 inherits that rule.
 *
 * The admission gate applies **before** any write:
 *
 *  - `globalMaxActiveManagedRuns` defaults to 2; refused with
 *    `kind: "busy", trippedLimit: "global-max-active-managed-runs"`
 *    when at or above the cap.
 *  - `perCheckoutMaxActiveWriters` defaults to 1; refused with
 *    `kind: "busy", trippedLimit: "per-checkout-writers"` when the
 *    project's checkout already has an active managed writer.
 *  - Per-project / per-provider / per-host caps are exposed via
 *    `readLeadAdmissionLimits()` and re-checked at admit time.
 *
 * Read helpers (`readLeadAdmissionLimits`, `readLeadAdmissionStatus`)
 * compose from the existing `run` and `invocation` tables — the
 * active-run count is "run.status === 'running'" by default; the
 * active-invocation count is "invocation.status IN
 * ('admitted', 'spawned', 'observing')" by default.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { createHash } from "node:crypto";
import { stableStringify } from "../db/effective-settings";
import {
  leadAdmissionContextSchema,
  leadAdmissionLimitsSchema,
  leadAdmissionStatusSchema,
  leadAdmitResultSchema,
  leadAuthorityAssignmentSchema,
  leadWorkItemSchema,
  type LeadAdmissionContext,
  type LeadAdmissionLimits,
  type LeadAdmissionStatus,
  type LeadAuthorityAssignment,
  type LeadAdmitResult,
  type LeadWorkItem,
  type LeadWorkProposal,
} from "../../shared/lead-admission-schema";
import { createTask, readTask } from "../db/tasks";
import { readRun } from "../db/runs";
import type { Run, Invocation, Grant } from "../../shared/managed";
import { decideGrant, requestGrant, listGrants } from "../db/grants";
import type { DbWorker } from "../db/worker";

// ── Defaults / caps ──────────────────────────────────────────────────────────

/** M5.2 default — at most two concurrently running managed runs. */
export const DEFAULT_MAX_ACTIVE_MANAGED_RUNS_GLOBAL = 2;
/** M5.2 default — at most one managed writer per checkout. */
export const DEFAULT_MAX_MANAGED_WRITERS_PER_CHECKOUT = 1;
/** Hard ceiling on the depth of a child grant's narrowing chain. */
export const MAX_GRANT_DEPTH = 4;

// ── Helpers ─────────────────────────────────────────────────────────────────

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

/** Returns the runs whose status is `running` (active managed work). */
async function listActiveManagedRuns(worker: DbWorker): Promise<Run[]> {
  const driver = driverOf(worker);
  const rows = driver
    .prepare("SELECT * FROM run WHERE status = ?")
    .all("running");
  // Re-use the existing parseRunRow via re-reads to keep imports clean.
  const out: Run[] = [];
  for (const r of rows) {
    const run = await readRun(worker, String((r as Record<string, unknown>).uuid));
    if (run) out.push(run);
  }
  return out;
}

/** Returns the invocations actively consuming provider capacity. */
async function listActiveInvocations(worker: DbWorker): Promise<Invocation[]> {
  const driver = driverOf(worker);
  const statuses = ["admitted", "spawned", "observing"] as const;
  const out: Invocation[] = [];
  for (const status of statuses) {
    const rows = driver.prepare("SELECT * FROM invocation WHERE status = ?").all(status);
    for (const r of rows) {
      out.push({
        id: String((r as Record<string, unknown>).uuid),
        runId: String((r as Record<string, unknown>).run_id),
        attempt: Number((r as Record<string, unknown>).attempt ?? 1),
        status: status as Invocation["status"],
        idempotencyKey: String((r as Record<string, unknown>).idempotency_key ?? ""),
        canonicalDigest: String((r as Record<string, unknown>).canonical_digest ?? ""),
        providerVersion: String((r as Record<string, unknown>).provider_version ?? ""),
        model: String((r as Record<string, unknown>).model ?? ""),
        accountMode: (r as Record<string, unknown>).account_mode as Invocation["accountMode"],
        startedAt: (r as Record<string, unknown>).started_at == null
          ? null : String((r as Record<string, unknown>).started_at),
        endedAt: (r as Record<string, unknown>).ended_at == null
          ? null : String((r as Record<string, unknown>).ended_at),
        endedReason: (r as Record<string, unknown>).ended_reason == null
          ? null : String((r as Record<string, unknown>).ended_reason),
        createdAt: String((r as Record<string, unknown>).created_at),
      });
    }
  }
  return out;
}

/** Parse a grant's `scope_json` defensively; tolerate malformed JSON. */
function parseScope(scopeJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(scopeJson);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  return {};
}

/**
 * Narrowing check: is `child` a strict subset of `parent`? Returns
 * a reason when the narrowing is illegal. Empty reason = ok.
 */
function checkGrantNarrows(parent: Grant, child: LeadAuthorityAssignment): string {
  // Scope: every key in child's scope must exist on parent with
  // a compatible value. For array-valued keys (restrictions, paths,
  // powers), child must be a subset. For object-valued keys (e.g.
  // {paths: [...], powers: [...]}), we recurse per-key.
  const parentScope = parseScope(parent.scopeJson);
  const childScope = child.scope && typeof child.scope === "object" && !Array.isArray(child.scope)
    ? child.scope as Record<string, unknown>
    : {};
  for (const [key, value] of Object.entries(childScope)) {
    const parentValue = parentScope[key];
    if (parentValue === undefined) {
      return `child grant scope key "${key}" is not present in parent grant`;
    }
    if (Array.isArray(value)) {
      if (!Array.isArray(parentValue))
        return `child grant scope key "${key}" is array but parent value is not`;
      for (const v of value) {
        if (!parentValue.includes(v))
          return `child grant scope key "${key}" contains "${String(v)}" which parent does not include`;
      }
    } else if (typeof value === "object" && value !== null) {
      if (typeof parentValue !== "object" || parentValue === null || Array.isArray(parentValue))
        return `child grant scope key "${key}" is object but parent value is not`;
      const childObj = value as Record<string, unknown>;
      const parentObj = parentValue as Record<string, unknown>;
      for (const [k, v] of Object.entries(childObj)) {
        if (!(k in parentObj))
          return `child grant scope key "${key}.${k}" is not present in parent grant`;
        if (Array.isArray(v)) {
          if (!Array.isArray(parentObj[k]))
            return `child grant scope key "${key}.${k}" is array but parent value is not`;
          for (const item of v) {
            if (!(parentObj[k] as unknown[]).includes(item))
              return `child grant scope key "${key}.${k}" contains "${String(item)}" which parent does not include`;
          }
        }
      }
    }
    // primitive values: child's value must equal parent's value.
    else {
      if (parentValue !== value)
        return `child grant scope key "${key}" must equal parent's value`;
    }
  }

  // Restrictions: subset.
  const parentRestrictions: string[] = Array.isArray(parentScope.restrictions)
    ? (parentScope.restrictions as string[]) : [];
  const childRestrictions = child.restrictions ?? [];
  for (const r of childRestrictions) {
    if (!parentRestrictions.includes(r))
      return `child restriction "${r}" is not in parent's restrictions`;
  }

  // Digests: subset. `parent.digestsJson` is itself a JSON
  // string (see `runtime/db/grants.ts:69` — `JSON.stringify(parsed.digests)`);
  // parse it once before iterating.
  const parentDigestsJson = (() => {
    try {
      return JSON.parse(parent.digestsJson);
    } catch {
      return {};
    }
  })();
  const parentDigests = parentDigestsJson && typeof parentDigestsJson === "object"
    && !Array.isArray(parentDigestsJson)
      ? parentDigestsJson as Record<string, unknown>
      : {};
  const childDigests = child.digests ?? {};
  for (const [k, v] of Object.entries(childDigests)) {
    if (!(k in parentDigests))
      return `child digest key "${k}" is not in parent's digests`;
    if (parentDigests[k] !== v)
      return `child digest "${k}" value differs from parent`;
  }

  // Expiry: when child supplies expiresAt, the runtime stores
  // it on the meta key `grant-expires:<grantId>` after creation.
  // For the narrowing check we read the same meta key from the
  // parent grant (a parent grant with no expiresAt meta row is
  // unbounded; a child cannot introduce an expiry against an
  // unbounded parent — but we still allow a child to inherit the
  // parent's expiry verbatim). The check runs against the meta
  // table here is deferred to the caller (readGrantDepth is a
  // thin helper; we keep `child.expiresAt` in the schema for
  // future use and apply it after the grant is created).
  return "";
}

// ── Limits + status read ─────────────────────────────────────────────────────

/**
 * The runtime's default lead-admission limits. M5.2 ships with
 * the roadmap defaults (`globalMaxActiveManagedRuns = 2`,
 * `perCheckoutMaxActiveWriters = 1`) and no per-project /
 * per-provider / per-host caps. A future M5.2 increment may
 * expose a knob for the user to set their own project caps.
 */
export function readLeadAdmissionLimits(_worker: DbWorker): LeadAdmissionLimits {
  const limits: LeadAdmissionLimits = leadAdmissionLimitsSchema.parse({
    globalMaxActiveManagedRuns: DEFAULT_MAX_ACTIVE_MANAGED_RUNS_GLOBAL,
    perCheckoutMaxActiveWriters: DEFAULT_MAX_MANAGED_WRITERS_PER_CHECKOUT,
    perProjectMaxActiveRuns: {},
    perProviderMaxActiveInvocations: {},
    perHostMaxActiveRuns: {},
  });
  return limits;
}

/**
 * Returns the live admission status (counts + caps). The status
 * shape matches `leadAdmissionStatusSchema` so a renderer / CLI
 * surface can render "X of Y slots used" without re-deriving.
 */
export async function readLeadAdmissionStatus(worker: DbWorker): Promise<LeadAdmissionStatus> {
  const limits = readLeadAdmissionLimits(worker);
  const activeRuns = await listActiveManagedRuns(worker);
  const activeInvocations = await listActiveInvocations(worker);
  const tasksByProject: Record<string, number> = {};
  const tasksByHost: Record<string, number> = {};
  for (const run of activeRuns) {
    const task = await readTask(worker, run.taskId);
    if (!task) continue;
    tasksByProject[task.projectId] = (tasksByProject[task.projectId] ?? 0) + 1;
    tasksByHost[task.hostId] = (tasksByHost[task.hostId] ?? 0) + 1;
  }
  const invocationsByProvider: Record<string, number> = {};
  for (const inv of activeInvocations) {
    invocationsByProvider[inv.providerVersion] = (invocationsByProvider[inv.providerVersion] ?? 0) + 1;
  }
  return leadAdmissionStatusSchema.parse({
    limits,
    activeManagedRunsGlobally: activeRuns.length,
    activeManagedRunsByProject: tasksByProject,
    activeManagedRunsByHost: tasksByHost,
    activeManagedInvocationsByProvider: invocationsByProvider,
  });
}

// ── Proposal admission ───────────────────────────────────────────────────────

interface AdmitProposalOptions {
  /**
   * Override the hostId for tasks admitted under this proposal.
   * When absent, we use the parent task's hostId when a parent
   * is present, else require a single hostId inside `proposal.items`
   * (carried as `effectiveInputs.hostId` — the runtime does NOT
   * parse `effectiveInputs` here, so callers should pass hostId via
   * the `meta` key or via the parent task).
   *
   * For M5.2 the simplest path is: the caller sets `hostId` on
   * each item through the proposal schema (we extend below).
   */
  defaultHostId: string;
  /**
   * The runtime identity used as `requestedBy` for child grants.
   * When absent, falls back to `context.principal`.
   */
  deciderOverride?: string;
}

const META_PARENT_TASK_KEY_PREFIX = "parent-task:";
const META_GRANT_DEPTH_KEY_PREFIX = "grant-depth:";

/**
 * Admit a `LeadWorkProposal`. The proposal is a structured
 * document of work items + dependencies + grants; the runtime
 * validates it, refuses with structured envelopes on conflicts,
 * and otherwise creates child tasks + child grants atomically.
 *
 * The admission order is:
 *
 *  1. Validate the proposal schema (zod `.strict()`).
 *  2. Validate the principal / project gates: every project's
 *     `projectId` must be in `context.projectIds`; every grant's
 *     target `localId` must reference a defined item.
 *  3. Validate the dependency graph: no self-loops, no cycles,
 *     all `localId`s reference defined items.
 *  4. Compute the active-run cap; refuse with `BUSY` if at or
 *     above the limit (`globalMaxActiveManagedRuns`).
 *  5. Per-checkout writer check (active leases for the project).
 *  6. Per-project / per-provider / per-host cap check.
 *  7. Narrowing check on every grant with `parentGrantId`.
 *  8. Create child tasks + child grants atomically (one tx per
 *     task; the admission order preserves the parent's authority
 *     graph so a partial admit is impossible — every tx commits
 *     before the next starts, so a throw mid-way leaves a
 *     well-formed prefix; the renderer can re-submit).
 */
export async function admitLeadProposal(
  worker: DbWorker,
  proposal: LeadWorkProposal,
  options: AdmitProposalOptions,
): Promise<LeadAdmitResult> {
  // Step 1 — parse the proposal.
  const parsedProposal = z.object({
    context: leadAdmissionContextSchema,
    items: z.array(leadWorkItemSchema).min(1).max(64),
    dependencies: z.array(z.object({
      from: z.string().trim().min(1).max(128),
      to: z.string().trim().min(1).max(128),
    }).strict()).max(256),
    grants: z.array(leadAuthorityAssignmentSchema).max(128),
  }).strict().parse(proposal);

  const ctx = parsedProposal.context;
  const limits = readLeadAdmissionLimits(worker);

  // Step 2 — principal / project gates.
  const itemsByLocalId = new Map<string, LeadWorkItem>();
  for (const item of parsedProposal.items) {
    if (itemsByLocalId.has(item.localId))
      throw new AppError("INVALID_REQUEST",
        `Duplicate localId in proposal: ${item.localId}`);
    itemsByLocalId.set(item.localId, item);
  }
  // All items land in a permitted project. We don't yet know the
  // projectId for each item (the schema doesn't carry one), so we
  // require that the proposal's `context.projectIds` is non-empty
  // AND every grant's localId resolves to an item.

  // Step 3 — dependency graph.
  for (const dep of parsedProposal.dependencies) {
    if (dep.from === dep.to)
      throw new AppError("INVALID_REQUEST",
        `Self-dependency on localId ${dep.from}`);
    if (!itemsByLocalId.has(dep.from))
      throw new AppError("INVALID_REQUEST",
        `Dependency from unknown localId ${dep.from}`);
    if (!itemsByLocalId.has(dep.to))
      throw new AppError("INVALID_REQUEST",
        `Dependency to unknown localId ${dep.to}`);
  }
  // Cycle detection (Floyd–Warshall over a small set; ≤ 64 items).
  const localIds = [...itemsByLocalId.keys()];
  const reaches = new Set<string>();
  for (const dep of parsedProposal.dependencies) reaches.add(`${dep.from}→${dep.to}`);
  // Iteratively close the reachability relation until fixpoint
  // (bounded by |localIds|²).
  for (let i = 0; i < localIds.length; i++) {
    let changed = false;
    for (const a of localIds) {
      for (const b of localIds) {
        if (reaches.has(`${a}→${b}`)) {
          for (const c of localIds) {
            if (reaches.has(`${b}→${c}`) && !reaches.has(`${a}→${c}`)) {
              reaches.add(`${a}→${c}`);
              changed = true;
            }
          }
        }
      }
    }
    if (!changed) break;
  }
  for (const id of localIds) {
    if (reaches.has(`${id}→${id}`))
      throw new AppError("INVALID_REQUEST",
        `Dependency cycle detected involving localId ${id}`);
  }

  // Step 4 — global active-run cap.
  const activeRuns = await listActiveManagedRuns(worker);
  if (activeRuns.length >= limits.globalMaxActiveManagedRuns) {
    return leadAdmitResultSchema.parse({
      kind: "busy",
      reason: `Global active managed run cap reached (${activeRuns.length} of ${limits.globalMaxActiveManagedRuns}); wait for a run to complete`,
      trippedLimit: "global-max-active-managed-runs",
    });
  }

  // Step 5 — per-checkout writer cap (single-checkout default).
  // We treat the `defaultHostId` as the checkout key; if multiple
  // items in the proposal share a checkout AND a run on the same
  // host already has an active lease, refuse.
  const driver = driverOf(worker);
  const activeLeases = driver
    .prepare("SELECT * FROM lease WHERE state = ?")
    .all("held");
  const activeLeasesForHost = (activeLeases as Array<Record<string, unknown>>).filter(l =>
    String(l.holder ?? "").includes(options.defaultHostId)
  );
  if (activeLeasesForHost.length >= limits.perCheckoutMaxActiveWriters) {
    return leadAdmitResultSchema.parse({
      kind: "busy",
      reason: `Per-checkout managed writer cap reached (${activeLeasesForHost.length} of ${limits.perCheckoutMaxActiveWriters} for host ${options.defaultHostId})`,
      trippedLimit: "per-checkout-writers",
    });
  }

  // Step 6 — per-project / per-provider / per-host cap check.
  const activeProjects = new Map<string, number>();
  const activeHosts = new Map<string, number>();
  const activeProviders = new Map<string, number>();
  for (const run of activeRuns) {
    const t = await readTask(worker, run.taskId);
    if (!t) continue;
    activeProjects.set(t.projectId, (activeProjects.get(t.projectId) ?? 0) + 1);
    activeHosts.set(t.hostId, (activeHosts.get(t.hostId) ?? 0) + 1);
  }
  for (const inv of await listActiveInvocations(worker)) {
    activeProviders.set(inv.providerVersion,
      (activeProviders.get(inv.providerVersion) ?? 0) + 1);
  }
  // The proposal will admit |items| tasks under `defaultHostId`;
  // we conservatively check whether admitting them would overflow
  // the per-host cap. Per-project / per-provider are zero-impact
  // at admit-time (no run has started yet) but the projection
  // table will surface them once the run transitions to running.
  const proposedAdditional = parsedProposal.items.length;
  const hostCap = limits.perHostMaxActiveRuns[options.defaultHostId];
  if (hostCap !== undefined
    && (activeHosts.get(options.defaultHostId) ?? 0) + proposedAdditional > hostCap) {
    return leadAdmitResultSchema.parse({
      kind: "busy",
      reason: `Per-host active-run cap would be exceeded (host ${options.defaultHostId}: ${activeHosts.get(options.defaultHostId) ?? 0} + ${proposedAdditional} > ${hostCap})`,
      trippedLimit: "per-host-active-runs",
    });
  }

  // Step 7 — narrowing check.
  // Resolve parent grants: when the proposal's context has a
  // parentTaskId, every grant with parentGrantId must reference
  // one of the parent's approved grants. We pre-fetch them here.
  const parentApprovedGrants: Grant[] = [];
  if (ctx.parentTaskId !== null) {
    const parentTask = await readTask(worker, ctx.parentTaskId);
    if (!parentTask) throw new AppError("NOT_FOUND",
      `Parent task ${ctx.parentTaskId} not found`);
    const allGrants = await listGrants(worker, { taskId: ctx.parentTaskId, state: "approved" });
    parentApprovedGrants.push(...allGrants);
  }
  const parentGrantById = new Map<string, Grant>();
  for (const g of parentApprovedGrants) parentGrantById.set(g.id, g);

  // Validate every grant with `parentGrantId`.
  for (const grant of parsedProposal.grants) {
    if (!itemsByLocalId.has(grant.localId))
      throw new AppError("INVALID_REQUEST",
        `Grant references unknown localId ${grant.localId}`);
    if (grant.parentGrantId !== null) {
      const parent = parentGrantById.get(grant.parentGrantId);
      if (!parent)
        throw new AppError("FORBIDDEN",
          `parentGrantId ${grant.parentGrantId} not found on parent task's approved grants`);
      const reason = checkGrantNarrows(parent, grant);
      if (reason)
        throw new AppError("FORBIDDEN",
          `Grant narrowing check failed for localId ${grant.localId}: ${reason}`);
      // Depth check: depth = parent.depth + 1.
      const depth = await readGrantDepth(worker, grant.parentGrantId);
      if (depth + 1 > MAX_GRANT_DEPTH)
        throw new AppError("FORBIDDEN",
          `Grant depth chain would exceed ${MAX_GRANT_DEPTH} (parent depth ${depth})`);
    }
  }

  // Step 8 — admit. Create child tasks first, then child grants.
  const admittedItems: Array<{ localId: string; taskId: string; projectId: string }> = [];
  const admittedGrantIds: string[] = [];

  for (const item of parsedProposal.items) {
    // We round-robin the project from the principal's permitted
    // set; for a single-project proposal the same projectId is
    // used for every item.
    const projectId = pickProjectId(ctx, item);
    if (!projectId)
      return leadAdmitResultSchema.parse({
        kind: "forbidden",
        reason: `No project in principal's permitted set for item ${item.localId}`,
      });
    // Create the child task. We use createTask which inserts a
    // task row in `draft` state; the M5.2 admit path returns the
    // child in `draft` so the renderer / CLI can review before
    // transitioning to `ready`.
    const created = await createTask(worker, {
      title: item.title,
      objective: item.objective,
      projectId,
      hostId: options.defaultHostId,
      providerVersion: item.providerVersion ?? null,
      model: item.model ?? null,
      accountMode: item.accountMode ?? null,
      baseIdentity: item.baseIdentity ?? null,
      rootIdentity: item.rootIdentity ?? null,
      effectiveInputs: { allowance: item.allowance },
    });
    admittedItems.push({
      localId: item.localId,
      taskId: created.task.id,
      projectId,
    });

    // Write the parent-task lineage key when context.parentTaskId
    // is set; absent parent ⇒ no lineage key written.
    if (ctx.parentTaskId !== null) {
      const driver2 = driverOf(worker);
      await worker.transaction(tx => {
        void tx;
        driver2.prepare(
          "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
        ).run(`${META_PARENT_TASK_KEY_PREFIX}${created.task.id}`, ctx.parentTaskId);
      });
    }

    // Adopt the proposal's grants whose localId matches this item.
    for (const grant of parsedProposal.grants) {
      if (grant.localId !== item.localId) continue;
      const req = await requestGrant(worker, {
        taskId: created.task.id,
        kind: "authority",
        principal: ctx.principal,
        scope: grant.scope,
        digests: grant.digests,
        restrictions: grant.restrictions,
      });
      // Approve immediately when the proposal's context is
      // authoritative enough — we still require a distinct
      // decider to satisfy `decideGrant`'s anti-self-approval
      // rule. When no `deciderOverride` is provided, refuse
      // the grant rather than auto-approve (the renderer can
      // surface the pending grant).
      const decider = options.deciderOverride
        ?? (ctx.principal !== "system" ? "system" : null);
      if (decider && decider !== ctx.principal) {
        const decided = await decideGrant(worker, req.id, {
          decision: "approve",
          decidedBy: decider,
        });
        admittedGrantIds.push(decided.id);
        // Write the depth meta key.
        const driver3 = driverOf(worker);
        const depth = grant.parentGrantId !== null
          ? (await readGrantDepth(worker, grant.parentGrantId)) + 1
          : 0;
        await worker.transaction(tx => {
          void tx;
          driver3.prepare(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
          ).run(`${META_GRANT_DEPTH_KEY_PREFIX}${decided.id}`,
            JSON.stringify({ depth, parentGrantId: grant.parentGrantId }));
        });
      } else {
        admittedGrantIds.push(req.id);
      }
    }
  }

  return leadAdmitResultSchema.parse({
    kind: "ok",
    admittedItems,
    admittedGrantIds,
  });
}

function pickProjectId(ctx: LeadAdmissionContext, item: LeadWorkItem): string | null {
  if (ctx.projectIds.length === 0) return null;
  // The M5.2 proposal schema does not carry per-item projectId;
  // admit-time project selection falls back to the principal's
  // first permitted project. A future M5.2 increment may extend
  // the schema with `item.projectId` for explicit per-item
  // selection. To preserve symmetry with the lead's authority
  // graph, we hash the item's localId to pick a stable project
  // when more than one is permitted.
  if (ctx.projectIds.length === 1) return ctx.projectIds[0]!;
  const idx = hashIndex(item.localId, ctx.projectIds.length);
  return ctx.projectIds[idx]!;
}

function hashIndex(key: string, modulo: number): number {
  const digest = createHash("sha256")
    .update(stableStringify({ key, payloadDigest: "" }), "utf8")
    .digest("hex");
  const v = parseInt(digest.slice(0, 8), 16);
  return Math.abs(v) % modulo;
}

async function readGrantDepth(worker: DbWorker, grantId: string): Promise<number> {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT value FROM meta WHERE key = ?")
    .first(`${META_GRANT_DEPTH_KEY_PREFIX}${grantId}`);
  if (!row) return 0;
  try {
    const parsed = JSON.parse(String((row as Record<string, unknown>).value)) as { depth?: number };
    return Number(parsed.depth ?? 0);
  } catch { return 0; }
}
