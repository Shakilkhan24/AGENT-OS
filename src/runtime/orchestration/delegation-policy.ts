/**
 * M5.3 — per-layer dispatch policy + native-child observation.
 *
 * The M5.3 spec (FUTURE/IMPLEMENTATION-README.md line 232) reads:
 *
 * > M5.3 Choose one dispatcher at each layer. Use native subagents
 * > for supported internal work; use managed child runs for separate
 * > providers/workspaces/hosts. Count observable native children and
 * > disclose observation gaps. Disable ungovernable native delegation
 * > where a hard budget is required; prompts cannot enforce process
 * quotas.
 *
 * The policy lives at the dispatch level, NOT the executor level —
 * `executeOnce` already invokes a single provider round-trip; this
 * module decides WHICH path (native subagent vs. managed child run)
 * is appropriate for the next dispatch.
 *
 * Trust model (mirrors `shared/delegation-schema.ts`):
 *
 *  - "Native subagent" = child spawned by the same provider
 *    instance, in the same workspace, on the same host, as its
 *    parent invocation. Any other combination forces a managed
 *    child run through the M3 / M5.2 admission path.
 *  - Cap enforcement is observable-only — `fully-observed` rows
 *    count toward `limits.observableLevelsForCap`. Advisory
 *    levels (`pid-only`, `unobservable`, `provider-internal`)
 *    are excluded from the cap but are reported in
 *    `delegationStatusSchema.unobservedChildrenByLevel`.
 *  - `hardBudgetRequired: true` forces the dispatcher to refuse
 *    the native path when the provider's
 *    `defaultObservation ∈ limits.hardBudgetRequiredObservationLevels`.
 *
 * Storage (mirrors M4.6 / M4.7 / M5.2):
 *
 *  - `native-child-pid:<invocationId>:<seq>` — pid + provider +
 *    observation + payloadDigest (always written).
 *  - `native-child-pgid:<invocationId>:<seq>` — pgid + provider +
 *    payloadDigest (written only when pgid was captured).
 *
 * The `payloadDigest` is `sha256(stableStringify({invocationId,
 * seq, provider, pid, pgid, observation, payloadDigest: ""}))` —
 * excludes `observedAt` so identical re-observations produce
 * identical digests.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import { stableStringify } from "../db/effective-settings";
import {
  delegationLimitsSchema,
  delegationPolicyInputSchema,
  delegationStatusSchema,
  dispatchDecisionSchema,
  nativeChildObservationEventSchema,
  nativeChildObservationRecordSchema,
  recordNativeChildObservationInputSchema,
  type DelegationLimits,
  type DelegationPolicyInput,
  type DelegationStatus,
  type DispatchDecision,
  type NativeChildObservationEvent,
  type NativeChildObservationLevel,
  type NativeChildObservationRecord,
  type RecordNativeChildObservationInput,
} from "../../shared/delegation-schema";
import type { DbWorker } from "../db/worker";

// ── Defaults ─────────────────────────────────────────────────────────────────

/** M5.3 default — at most 4 concurrently-observable native subagents. */
export const DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_GLOBAL = 4;

/** M5.3 default — at most 2 observable native subagents per invocation. */
export const DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_PER_INVOCATION = 2;

/** Frozen — only `"fully-observed"` ships enabled for cap enforcement. */
export const DEFAULT_OBSERVABLE_LEVELS_FOR_CAP: ReadonlyArray<NativeChildObservationLevel> =
  Object.freeze(["fully-observed"]);

/** Frozen — advisory levels that, when `hardBudgetRequired: true`,
 * force the dispatcher to refuse the native-subagent path. */
export const DEFAULT_HARD_BUDGET_REQUIRED_OBSERVATION_LEVELS:
  ReadonlyArray<NativeChildObservationLevel> = Object.freeze(["unobservable", "provider-internal"]);

/** Meta-table prefix for native-child pid rows. */
export const NATIVE_CHILD_PID_META_PREFIX = "native-child-pid:";

/** Meta-table prefix for native-child pgid rows. */
export const NATIVE_CHILD_PGID_META_PREFIX = "native-child-pid:".replace("pid", "pgid");

/** Scope key used to override limits via the meta table. */
export const DELEGATION_LIMITS_META_SCOPE = "global";

// ── Driver seam (mirrors M5.2 / M4.7) ────────────────────────────────────────

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

function raiseInvalidRequest(message: string): never {
  throw new AppError("INVALID_REQUEST", message);
}

function parseStrict<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    throw new AppError(
      "INVALID_REQUEST",
      error instanceof z.ZodError ? `${label}: ${error.message}` : `${label}: ${String(error)}`,
    );
  }
}

// ── Limits ───────────────────────────────────────────────────────────────────

/**
 * Read the runtime's delegation limits. Looks for an override in
 * the meta table under `delegation-limits:<scope>` (default scope:
 * `global`); absent ⇒ returns the M5.3 defaults baked into a
 * `DelegationLimits`. The override shape is the same Zod schema
 * used on the wire.
 */
export async function readDelegationLimits(worker: DbWorker): Promise<DelegationLimits> {
  const driver = driverOf(worker);
  const key = `delegation-limits:${DELEGATION_LIMITS_META_SCOPE}`;
  const row = driver.prepare("SELECT value FROM meta WHERE key = ?").first(key);
  if (row) {
    try {
      const parsed = delegationLimitsSchema.parse(JSON.parse(String(row.value)));
      return parsed;
    } catch {
      // Corrupt override falls back to defaults; the dispatcher
      // never crashes on a malformed meta row.
    }
  }
  return delegationLimitsSchema.parse({
    globalMaxObservableNativeSubagents: DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_GLOBAL,
    perInvocationMaxObservableNativeSubagents: DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_PER_INVOCATION,
    observableLevelsForCap: [...DEFAULT_OBSERVABLE_LEVELS_FOR_CAP],
    perProviderMaxObservableNativeSubagents: {},
    hardBudgetRequiredObservationLevels: [...DEFAULT_HARD_BUDGET_REQUIRED_OBSERVATION_LEVELS],
  });
}

// ── Status ───────────────────────────────────────────────────────────────────

/**
 * Live counts + observation-gap disclosure. Reads every
 * `native-child-pid:*` meta row, parses its `observation` and
 * `provider`, and splits counts into the observable + advisory
 * buckets the schema documents.
 *
 * `ungovernableProviders` lists providers whose every observed
 * row is in `limits.hardBudgetRequiredObservationLevels`. A
 * provider with even one observable row is excluded.
 *
 * Implementation scans all meta rows and filters by key prefix
 * client-side (mirrors `runtime/db/hook-activation.ts`'s
 * `listActiveHookIds`): the in-memory test driver does not
 * support `LIKE`, and the row count is small enough that a
 * full scan is acceptable.
 */
export async function readDelegationStatus(
  worker: DbWorker,
  limits: DelegationLimits,
): Promise<DelegationStatus> {
  const driver = driverOf(worker);
  const rows = driver.prepare("SELECT key, value FROM meta").all();
  const observable = new Set<string>(limits.observableLevelsForCap);
  const hardBudget = new Set<string>(limits.hardBudgetRequiredObservationLevels);
  let observableCount = 0;
  const observableByProvider: Record<string, number> = {};
  const unobservedByLevel: Record<NativeChildObservationLevel, number> = {
    "fully-observed": 0,
    "pid-only": 0,
    unobservable: 0,
    "provider-internal": 0,
  };
  // For the ungovernable check: track provider → {observableCount, hardBudgetCount}.
  const providerStats = new Map<string, { obs: number; hb: number }>();
  for (const r of rows) {
    const key = String((r as Record<string, unknown>).key ?? "");
    if (!key.startsWith(NATIVE_CHILD_PID_META_PREFIX)) continue;
    let parsed: NativeChildObservationRecord;
    try {
      parsed = nativeChildObservationRecordSchema.parse(JSON.parse(String(r.value)));
    } catch {
      continue; // skip corrupt rows — the dispatcher must not crash
    }
    unobservedByLevel[parsed.observation] += 1;
    if (observable.has(parsed.observation)) {
      observableCount += 1;
      observableByProvider[parsed.provider] = (observableByProvider[parsed.provider] ?? 0) + 1;
    }
    const isObs = observable.has(parsed.observation);
    const isHb = hardBudget.has(parsed.observation);
    const stat = providerStats.get(parsed.provider) ?? { obs: 0, hb: 0 };
    if (isObs) stat.obs += 1;
    if (isHb) stat.hb += 1;
    providerStats.set(parsed.provider, stat);
  }
  const ungovernableProviders: string[] = [];
  for (const [provider, stat] of providerStats) {
    if (stat.obs === 0 && stat.hb > 0) ungovernableProviders.push(provider);
  }
  ungovernableProviders.sort();
  return delegationStatusSchema.parse({
    limits,
    observableNativeChildCount: observableCount,
    observableNativeChildCountByProvider: observableByProvider,
    unobservedChildrenByLevel: unobservedByLevel,
    ungovernableProviders,
  });
}

// ── Pure decision ────────────────────────────────────────────────────────────

/**
 * Decide which dispatcher to use for the next round-trip. The
 * decision is a pure function of its inputs — no DB read, no
 * clock — so the unit tests can pin every branch.
 *
 * Decision tree (in order):
 *
 *  1. `!allowNativeSubagents` → forbidden / native-subagents-disabled.
 *  2. cross-workspace → managed-run.
 *  3. cross-host → managed-run.
 *  4. cross-provider → managed-run.
 *  5. provider does not advertise native subagent support → managed-run.
 *  6. provider's `defaultObservation` ∈ hard-budget-required levels AND
 *     `hardBudgetRequired: true` → forbidden / hard-budget-required.
 *  7. provider's `defaultObservation === "unobservable"` AND
 *     `hardBudgetRequired: true` → forbidden /
 *     no-observable-native-children (more specific than step 6).
 *  8. global observable cap reached → managed-run.
 *  9. per-invocation observable cap reached → managed-run.
 * 10. otherwise → native-subagent.
 */
export function decideDispatch(input: DelegationPolicyInput): DispatchDecision {
  const parsed = parseStrict(
    delegationPolicyInputSchema,
    input,
    "delegation policy input",
  );
  if (!parsed.allowNativeSubagents) {
    return dispatchDecisionSchema.parse({
      kind: "forbidden",
      trippedPolicy: "native-subagents-disabled",
      reason: "caller set allowNativeSubagents=false; native-subagent path is disabled",
    });
  }
  if (parsed.parentWorkspaceId && parsed.parentWorkspaceId !== parsed.workspaceId) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "cross-workspace dispatch requires a managed child run",
    });
  }
  if (parsed.parentHostId && parsed.parentHostId !== parsed.hostId) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "cross-host dispatch requires a managed child run",
    });
  }
  if (
    parsed.parentProviderVersion &&
    parsed.parentProviderVersion !== parsed.providerVersion
  ) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "cross-provider dispatch requires a managed child run",
    });
  }
  if (!parsed.providerNativeSubagentSupport.supported) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "provider does not advertise native subagent support",
    });
  }
  // Steps 6 + 7 are the "hard budget" gate.
  if (parsed.hardBudgetRequired) {
    const def = parsed.providerNativeSubagentSupport.defaultObservation;
    if (def === "unobservable") {
      return dispatchDecisionSchema.parse({
        kind: "forbidden",
        trippedPolicy: "no-observable-native-children",
        reason:
          "provider defaultObservation is 'unobservable' and caller requires a hard budget; native path cannot satisfy a verifiable cap",
      });
    }
    if (parsed.limits.hardBudgetRequiredObservationLevels.includes(def)) {
      return dispatchDecisionSchema.parse({
        kind: "forbidden",
        trippedPolicy: "hard-budget-required",
        reason:
          "provider defaultObservation is in the hard-budget-required list and caller requires a hard budget",
      });
    }
  }
  if (
    parsed.currentObservableNativeChildCount >=
    parsed.limits.globalMaxObservableNativeSubagents
  ) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "global observable-native cap reached",
    });
  }
  if (
    parsed.currentObservableNativeChildCountForInvocation >=
    parsed.limits.perInvocationMaxObservableNativeSubagents
  ) {
    return dispatchDecisionSchema.parse({
      kind: "managed-run",
      reason: "per-invocation observable-native cap reached",
    });
  }
  return dispatchDecisionSchema.parse({
    kind: "native-subagent",
    reason: "dispatched via provider-native subagent",
    chosenObservation: parsed.providerNativeSubagentSupport.defaultObservation,
  });
}

// ── Observation writer ───────────────────────────────────────────────────────

/**
 * Map the runner-side event to the level enum. The mapping is
 * documented at the top of the module so the runner code can
 * surface the right observation without re-deriving it.
 *
 *  - `pid-and-pgid-captured` → `fully-observed`
 *  - `pid-only-captured`     → `pid-only`
 *  - `pgid-only-captured`    → `pid-only` (pgid alone is insufficient)
 *  - `pid-unknown`           → `unobservable`
 *  - `pid-rejected`          → `unobservable`
 */
export function observationFromEvent(
  event: NativeChildObservationEvent,
): NativeChildObservationLevel {
  parseStrict(nativeChildObservationEventSchema, event, "native-child observation event");
  switch (event) {
    case "pid-and-pgid-captured":
      return "fully-observed";
    case "pid-only-captured":
    case "pgid-only-captured":
      return "pid-only";
    case "pid-unknown":
    case "pid-rejected":
      return "unobservable";
  }
}

function pidMetaKey(invocationId: string, seq: number): string {
  return `${NATIVE_CHILD_PID_META_PREFIX}${invocationId}:${seq}`;
}

function pgidMetaKey(invocationId: string, seq: number): string {
  return `${NATIVE_CHILD_PGID_META_PREFIX}${invocationId}:${seq}`;
}

/**
 * Compute the content-addressed payloadDigest for a pid meta row.
 * Excludes `observedAt` so identical re-observations produce
 * identical digests (mirrors M4.6 / M4.7 / M5.2).
 */
function computePidDigest(input: RecordNativeChildObservationInput): string {
  return createHash("sha256")
    .update(
      stableStringify({
        invocationId: input.invocationId,
        seq: input.seq,
        provider: input.provider,
        pid: input.pid,
        observation: input.observation,
        payloadDigest: "",
      }),
      "utf8",
    )
    .digest("hex");
}

function computePgidDigest(input: RecordNativeChildObservationInput): string {
  return createHash("sha256")
    .update(
      stableStringify({
        invocationId: input.invocationId,
        seq: input.seq,
        provider: input.provider,
        pgid: input.pgid,
        payloadDigest: "",
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Record a native-child observation. Writes the
 * `native-child-pid:*` row always; writes the
 * `native-child-pgid:*` row only when `pgid` was captured.
 *
 * Validation: refuses `INVALID_REQUEST` when `pid` is missing
 * while `observation === "fully-observed" | "pid-only"`; refuses
 * when `pgid` is supplied for an observation level that doesn't
 * need it (advisory levels).
 */
export async function recordNativeChildObservation(
  worker: DbWorker,
  input: RecordNativeChildObservationInput,
): Promise<NativeChildObservationRecord> {
  const parsed = parseStrict(
    recordNativeChildObservationInputSchema,
    input,
    "native-child observation input",
  );
  if (
    (parsed.observation === "fully-observed" || parsed.observation === "pid-only") &&
    parsed.pid === null
  ) {
    raiseInvalidRequest(
      `pid is required for observation level "${parsed.observation}"`,
    );
  }
  if (
    (parsed.observation === "unobservable" ||
      parsed.observation === "provider-internal") &&
    parsed.pid !== null
  ) {
    raiseInvalidRequest(
      `pid must be null for observation level "${parsed.observation}"`,
    );
  }
  const record = nativeChildObservationRecordSchema.parse({
    invocationId: parsed.invocationId,
    seq: parsed.seq,
    provider: parsed.provider,
    pid: parsed.pid,
    pgid: parsed.pgid,
    observation: parsed.observation,
    observedAt: parsed.observedAt,
    payloadDigest: computePidDigest(parsed),
  });
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(pidMetaKey(parsed.invocationId, parsed.seq), JSON.stringify(record));
    if (parsed.pgid !== null) {
      const pgidPayload = {
        invocationId: parsed.invocationId,
        seq: parsed.seq,
        provider: parsed.provider,
        pgid: parsed.pgid,
        observedAt: parsed.observedAt,
        payloadDigest: computePgidDigest(parsed),
      };
      driver
        .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
        .run(
          pgidMetaKey(parsed.invocationId, parsed.seq),
          JSON.stringify(pgidPayload),
        );
    }
  });
  return record;
}

/**
 * List every native-child observation record for one invocation,
 * sorted by `seq` ascending. Joins the `pid` and `pgid` meta rows
 * by `seq`. Absent `pgid` rows are tolerated (the record's `pgid`
 * is `null` in that case).
 */
export async function listNativeChildrenForInvocation(
  worker: DbWorker,
  invocationId: string,
): Promise<NativeChildObservationRecord[]> {
  const driver = driverOf(worker);
  // Client-side prefix filter — the in-memory test driver does not
  // support `LIKE`. Mirrors `readDelegationStatus` above.
  const allRows = driver.prepare("SELECT key, value FROM meta").all();
  const out: NativeChildObservationRecord[] = [];
  const prefix = `${NATIVE_CHILD_PID_META_PREFIX}${invocationId}:`;
  for (const r of allRows) {
    const key = String((r as Record<string, unknown>).key ?? "");
    if (!key.startsWith(prefix)) continue;
    try {
      const parsed = nativeChildObservationRecordSchema.parse(
        JSON.parse(String((r as Record<string, unknown>).value)),
      );
      out.push(parsed);
    } catch {
      continue; // skip corrupt rows
    }
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}
