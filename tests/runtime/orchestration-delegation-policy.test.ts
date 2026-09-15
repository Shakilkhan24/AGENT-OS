/**
 * M5.3 — delegation-policy tests.
 *
 * Coverage (14 focused tests):
 *  - readDelegationLimits returns the M5.3 defaults
 *    (globalMaxObservableNativeSubagents = 4,
 *    perInvocationMaxObservableNativeSubagents = 2,
 *    observableLevelsForCap = ["fully-observed"],
 *    hardBudgetRequiredObservationLevels includes
 *    "unobservable" and "provider-internal").
 *  - readDelegationStatus reports zero observable children and an
 *    empty per-provider map when no native children have been
 *    recorded.
 *  - readDelegationStatus counts observable children and groups
 *    them by provider when native-child meta rows exist.
 *  - readDelegationStatus surfaces unobserved children in
 *    unobservedChildrenByLevel and lists ungovernable providers.
 *  - decideDispatch chooses native-subagent when provider supports
 *    it, same workspace/host/provider, allowNativeSubagents is
 *    true, and the caps are not reached.
 *  - decideDispatch chooses managed-run when workspaceId differs
 *    (cross-workspace).
 *  - decideDispatch chooses managed-run when hostId differs
 *    (cross-host).
 *  - decideDispatch chooses managed-run when providerVersion
 *    differs (cross-provider).
 *  - decideDispatch returns forbidden with trippedPolicy
 *    native-subagents-disabled when allowNativeSubagents is false.
 *  - decideDispatch returns forbidden with trippedPolicy
 *    hard-budget-required when hardBudgetRequired is true and the
 *    provider's defaultObservation is provider-internal.
 *  - decideDispatch returns forbidden with trippedPolicy
 *    no-observable-native-children when hardBudgetRequired is true
 *    and defaultObservation is unobservable.
 *  - decideDispatch chooses managed-run when global
 *    observable-native cap is reached (returns managed-run not
 *    forbidden because the alternative is still available).
 *  - decideDispatch chooses managed-run when per-invocation
 *    observable-native cap is reached.
 *  - recordNativeChildObservation writes pid + pgid meta keys with
 *    a content-addressed payloadDigest that is deterministic across
 *    identical re-observations and tolerates a missing pgid
 *    (writes only the pid row).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import {
  readDelegationLimits,
  readDelegationStatus,
  decideDispatch,
  recordNativeChildObservation,
  listNativeChildrenForInvocation,
  observationFromEvent,
  NATIVE_CHILD_PID_META_PREFIX,
  NATIVE_CHILD_PGID_META_PREFIX,
  DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_GLOBAL,
  DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_PER_INVOCATION,
  DEFAULT_OBSERVABLE_LEVELS_FOR_CAP,
} from "../../src/runtime/orchestration/delegation-policy";
import type {
  DelegationPolicyInput,
  NativeSubagentSupport,
} from "../../src/shared/delegation-schema";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const SUPPORTED_CLAUDE: NativeSubagentSupport = {
  supported: true,
  defaultObservation: "fully-observed",
  capturesPgid: true,
};

function baseInput(overrides?: Partial<DelegationPolicyInput>): DelegationPolicyInput {
  return {
    workspaceId: randomUUID(),
    hostId: "host-a",
    providerVersion: "claude@1.0.0",
    parentProviderVersion: "claude@1.0.0",
    parentWorkspaceId: null,
    parentHostId: null,
    invocationId: randomUUID(),
    providerNativeSubagentSupport: SUPPORTED_CLAUDE,
    hardBudgetRequired: false,
    allowNativeSubagents: true,
    currentObservableNativeChildCount: 0,
    currentObservableNativeChildCountForInvocation: 0,
    limits: {
      globalMaxObservableNativeSubagents: 4,
      perInvocationMaxObservableNativeSubagents: 2,
      observableLevelsForCap: ["fully-observed"],
      perProviderMaxObservableNativeSubagents: {},
      hardBudgetRequiredObservationLevels: ["unobservable", "provider-internal"],
    },
    ...overrides,
  };
}

test("readDelegationLimits returns the M5.3 defaults", async () => {
  const worker = freshWorker();
  try {
    const limits = await readDelegationLimits(worker);
    assert.equal(
      limits.globalMaxObservableNativeSubagents,
      DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_GLOBAL,
    );
    assert.equal(
      limits.perInvocationMaxObservableNativeSubagents,
      DEFAULT_MAX_OBSERVABLE_NATIVE_SUBAGENTS_PER_INVOCATION,
    );
    assert.deepEqual(
      [...limits.observableLevelsForCap],
      [...DEFAULT_OBSERVABLE_LEVELS_FOR_CAP],
    );
    assert.ok(
      limits.hardBudgetRequiredObservationLevels.includes("unobservable"),
      "hard-budget list must include 'unobservable'",
    );
    assert.ok(
      limits.hardBudgetRequiredObservationLevels.includes("provider-internal"),
      "hard-budget list must include 'provider-internal'",
    );
    assert.equal(limits.globalMaxObservableNativeSubagents, 4);
    assert.equal(limits.perInvocationMaxObservableNativeSubagents, 2);
  } finally { void worker.close(); }
});

test("readDelegationStatus reports zero observable children and an empty per-provider map when no native children have been recorded", async () => {
  const worker = freshWorker();
  try {
    const limits = await readDelegationLimits(worker);
    const status = await readDelegationStatus(worker, limits);
    assert.equal(status.observableNativeChildCount, 0);
    assert.deepEqual(status.observableNativeChildCountByProvider, {});
    assert.equal(status.unobservedChildrenByLevel["fully-observed"], 0);
    assert.equal(status.unobservedChildrenByLevel["pid-only"], 0);
    assert.equal(status.unobservedChildrenByLevel.unobservable, 0);
    assert.equal(status.unobservedChildrenByLevel["provider-internal"], 0);
    assert.deepEqual(status.ungovernableProviders, []);
  } finally { void worker.close(); }
});

test("readDelegationStatus counts observable children and groups them by provider when native-child meta rows exist", async () => {
  const worker = freshWorker();
  try {
    const invocationId = randomUUID();
    await recordNativeChildObservation(worker, {
      invocationId, seq: 1, provider: "claude", pid: 1001, pgid: 1000,
      observation: "fully-observed", observedAt: new Date().toISOString(),
    });
    await recordNativeChildObservation(worker, {
      invocationId, seq: 2, provider: "claude", pid: 1002, pgid: 1000,
      observation: "fully-observed", observedAt: new Date().toISOString(),
    });
    await recordNativeChildObservation(worker, {
      invocationId, seq: 3, provider: "codex", pid: 2001, pgid: null,
      observation: "pid-only", observedAt: new Date().toISOString(),
    });
    const limits = await readDelegationLimits(worker);
    const status = await readDelegationStatus(worker, limits);
    // Only `fully-observed` rows count toward observableLevelsForCap.
    assert.equal(status.observableNativeChildCount, 2);
    assert.equal(status.observableNativeChildCountByProvider.claude, 2);
    assert.equal(status.observableNativeChildCountByProvider.codex, undefined);
    assert.equal(status.unobservedChildrenByLevel["fully-observed"], 2);
    assert.equal(status.unobservedChildrenByLevel["pid-only"], 1);
    // Both providers have at least one fully-observed row, so neither
    // is reported as ungovernable.
    assert.deepEqual(status.ungovernableProviders, []);
  } finally { void worker.close(); }
});

test("readDelegationStatus surfaces unobserved children in unobservedChildrenByLevel and lists ungovernable providers", async () => {
  const worker = freshWorker();
  try {
    const invocationA = randomUUID();
    await recordNativeChildObservation(worker, {
      invocationId: invocationA, seq: 1, provider: "claude", pid: 1001, pgid: 1000,
      observation: "fully-observed", observedAt: new Date().toISOString(),
    });
    const invocationB = randomUUID();
    await recordNativeChildObservation(worker, {
      invocationId: invocationB, seq: 1, provider: "codex", pid: null, pgid: null,
      observation: "unobservable", observedAt: new Date().toISOString(),
    });
    await recordNativeChildObservation(worker, {
      invocationId: invocationB, seq: 2, provider: "codex", pid: null, pgid: null,
      observation: "unobservable", observedAt: new Date().toISOString(),
    });
    const limits = await readDelegationLimits(worker);
    const status = await readDelegationStatus(worker, limits);
    assert.equal(status.unobservedChildrenByLevel.unobservable, 2);
    // codex only has `unobservable` rows → ungovernable; claude has
    // a fully-observed row → not ungovernable.
    assert.deepEqual(status.ungovernableProviders, ["codex"]);
  } finally { void worker.close(); }
});

test("decideDispatch chooses native-subagent when provider supports it, same workspace/host/provider, allowNativeSubagents is true, and the caps are not reached", () => {
  const result = decideDispatch(baseInput());
  assert.equal(result.kind, "native-subagent");
  if (result.kind === "native-subagent") {
    assert.equal(result.chosenObservation, "fully-observed");
  }
});

test("decideDispatch chooses managed-run when workspaceId differs (cross-workspace)", () => {
  const parentWorkspaceId = randomUUID();
  const result = decideDispatch(baseInput({
    parentWorkspaceId,
    workspaceId: randomUUID(), // different
  }));
  assert.equal(result.kind, "managed-run");
});

test("decideDispatch chooses managed-run when hostId differs (cross-host)", () => {
  const result = decideDispatch(baseInput({
    parentHostId: "host-b",
    hostId: "host-a",
  }));
  assert.equal(result.kind, "managed-run");
});

test("decideDispatch chooses managed-run when providerVersion differs (cross-provider)", () => {
  const result = decideDispatch(baseInput({
    parentProviderVersion: "claude@1.0.0",
    providerVersion: "codex@0.5.0",
  }));
  assert.equal(result.kind, "managed-run");
});

test("decideDispatch returns forbidden with trippedPolicy native-subagents-disabled when allowNativeSubagents is false", () => {
  const result = decideDispatch(baseInput({ allowNativeSubagents: false }));
  assert.equal(result.kind, "forbidden");
  if (result.kind === "forbidden") {
    assert.equal(result.trippedPolicy, "native-subagents-disabled");
  }
});

test("decideDispatch returns forbidden with trippedPolicy hard-budget-required when hardBudgetRequired is true and the provider's defaultObservation is provider-internal", () => {
  const result = decideDispatch(baseInput({
    hardBudgetRequired: true,
    providerNativeSubagentSupport: {
      supported: true,
      defaultObservation: "provider-internal",
      capturesPgid: false,
    },
  }));
  assert.equal(result.kind, "forbidden");
  if (result.kind === "forbidden") {
    assert.equal(result.trippedPolicy, "hard-budget-required");
  }
});

test("decideDispatch returns forbidden with trippedPolicy no-observable-native-children when hardBudgetRequired is true and defaultObservation is unobservable", () => {
  const result = decideDispatch(baseInput({
    hardBudgetRequired: true,
    providerNativeSubagentSupport: {
      supported: true,
      defaultObservation: "unobservable",
      capturesPgid: false,
    },
  }));
  assert.equal(result.kind, "forbidden");
  if (result.kind === "forbidden") {
    assert.equal(result.trippedPolicy, "no-observable-native-children");
  }
});

test("decideDispatch chooses managed-run when global observable-native cap is reached", () => {
  const result = decideDispatch(baseInput({
    currentObservableNativeChildCount: 4, // globalMaxObservableNativeSubagents
  }));
  assert.equal(result.kind, "managed-run");
  if (result.kind === "managed-run") {
    assert.match(result.reason, /global observable-native cap reached/);
  }
});

test("decideDispatch chooses managed-run when per-invocation observable-native cap is reached", () => {
  const result = decideDispatch(baseInput({
    currentObservableNativeChildCountForInvocation: 2, // perInvocationMaxObservableNativeSubagents
  }));
  assert.equal(result.kind, "managed-run");
  if (result.kind === "managed-run") {
    assert.match(result.reason, /per-invocation observable-native cap reached/);
  }
});

test("recordNativeChildObservation writes pid + pgid meta keys with a content-addressed payloadDigest that is deterministic across identical re-observations and tolerates a missing pgid (writes only the pid row)", async () => {
  const worker = freshWorker();
  try {
    const invocationId = randomUUID();
    const observedAt = new Date().toISOString();
    const first = await recordNativeChildObservation(worker, {
      invocationId, seq: 1, provider: "claude", pid: 4242, pgid: 4000,
      observation: "fully-observed", observedAt,
    });
    const second = await recordNativeChildObservation(worker, {
      invocationId, seq: 1, provider: "claude", pid: 4242, pgid: 4000,
      observation: "fully-observed", observedAt,
    });
    // Identical inputs → identical payloadDigest (timestamp excluded).
    assert.equal(first.payloadDigest, second.payloadDigest);
    assert.match(first.payloadDigest, /^[0-9a-f]{64}$/);

    // Read the meta table directly via the same driverOf helper the
    // module uses; verify the meta-key naming convention.
    const driver = (worker as unknown as { driver: { prepare(sql: string): { first(...b: unknown[]): Record<string, unknown> | undefined; all(...b: unknown[]): Array<Record<string, unknown>> } } }).driver;
    const pidKey = `${NATIVE_CHILD_PID_META_PREFIX}${invocationId}:1`;
    const pgidKey = `${NATIVE_CHILD_PGID_META_PREFIX}${invocationId}:1`;
    const allRows = driver.prepare("SELECT key, value FROM meta").all();
    const pidRow = allRows.find(r => String((r as Record<string, unknown>).key) === pidKey);
    const pgidRow = allRows.find(r => String((r as Record<string, unknown>).key) === pgidKey);
    assert.ok(pidRow, "pid meta row must exist");
    assert.ok(pgidRow, "pgid meta row must exist");

    // Tolerate a missing pgid: writes only the pid row.
    const invocationIdB = randomUUID();
    await recordNativeChildObservation(worker, {
      invocationId: invocationIdB, seq: 1, provider: "codex", pid: 5555, pgid: null,
      observation: "pid-only", observedAt: new Date().toISOString(),
    });
    const pidKeyB = `${NATIVE_CHILD_PID_META_PREFIX}${invocationIdB}:1`;
    const pgidKeyB = `${NATIVE_CHILD_PGID_META_PREFIX}${invocationIdB}:1`;
    const allRowsB = driver.prepare("SELECT key, value FROM meta").all();
    const pidRowB = allRowsB.find(r => String((r as Record<string, unknown>).key) === pidKeyB);
    const pgidRowB = allRowsB.find(r => String((r as Record<string, unknown>).key) === pgidKeyB);
    assert.ok(pidRowB, "pid-only row must be written");
    assert.equal(pgidRowB, undefined,
      "pid-only without pgid must NOT write a pgid row");

    // listNativeChildrenForInvocation round-trips the records sorted by seq.
    const list = await listNativeChildrenForInvocation(worker, invocationId);
    assert.equal(list.length, 1);
    assert.equal(list[0].seq, 1);
    assert.equal(list[0].pid, 4242);
    assert.equal(list[0].pgid, 4000);
  } finally { void worker.close(); }
});

// Extra: observationFromEvent maps every event variant to the
// documented level.
test("observationFromEvent maps every event variant to the documented level", () => {
  assert.equal(observationFromEvent("pid-and-pgid-captured"), "fully-observed");
  assert.equal(observationFromEvent("pid-only-captured"), "pid-only");
  assert.equal(observationFromEvent("pgid-only-captured"), "pid-only");
  assert.equal(observationFromEvent("pid-unknown"), "unobservable");
  assert.equal(observationFromEvent("pid-rejected"), "unobservable");
});
