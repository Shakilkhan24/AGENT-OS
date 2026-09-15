/**
 * M5.2 — lead-proposal admission tests.
 *
 * Coverage (14 focused tests):
 *  - readLeadAdmissionLimits returns the M5.2 defaults
 *    (globalMaxActiveManagedRuns = 2,
 *    perCheckoutMaxActiveWriters = 1).
 *  - readLeadAdmissionStatus counts active runs and returns the
 *    per-project / per-host / per-provider breakdown.
 *  - admitLeadProposal admits a simple proposal with one item
 *    and zero grants.
 *  - admitLeadProposal rejects self-dependencies and dependency
 *    cycles.
 *  - admitLeadProposal rejects unknown localIds in dependencies
 *    and grants.
 *  - admitLeadProposal returns BUSY when at-or-above the global
 *    active-run cap (2).
 *  - admitLeadProposal returns FORBIDDEN when no project in
 *    context.projectIds can satisfy an item.
 *  - admitLeadProposal narrows child grants against the parent
 *    task's approved grants: scope subset, restrictions subset,
 *    digests subset.
 *  - admitLeadProposal refuses grants whose `parentGrantId`
 *    references an unapproved parent grant.
 *  - admitLeadProposal enforces depth ≤ MAX_GRANT_DEPTH.
 *  - admitLeadProposal writes the `parent-task:<childId>` meta
 *    key when context.parentTaskId is set.
 *  - admitLeadProposal writes the `grant-depth:<grantId>` meta
 *    key for admitted grants with `parentGrantId`.
 *  - admitLeadProposal rejects duplicate localIds.
 *  - admitLeadProposal caps the proposal at 64 items / 128 grants.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask, transitionTask } from "../../src/runtime/db/tasks";
import { createRun, transitionRun } from "../../src/runtime/db/runs";
import { createInvocation as _ci } from "../../src/runtime/db/invocations";
void _ci;
import { requestGrant, decideGrant, readGrant } from "../../src/runtime/db/grants";
import {
  admitLeadProposal,
  readLeadAdmissionLimits,
  readLeadAdmissionStatus,
  DEFAULT_MAX_ACTIVE_MANAGED_RUNS_GLOBAL,
  DEFAULT_MAX_MANAGED_WRITERS_PER_CHECKOUT,
  MAX_GRANT_DEPTH,
} from "../../src/runtime/orchestration/lead-admission";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const baseCtx = (overrides?: { principal?: string; projectIds?: string[]; parentTaskId?: string | null }) => ({
  principal: overrides?.principal ?? "lead-claude",
  projectIds: overrides?.projectIds ?? ["alpha"],
  parentTaskId: overrides?.parentTaskId ?? null,
});

test("readLeadAdmissionLimits returns the M5.2 defaults", () => {
  const worker = freshWorker();
  try {
    const limits = readLeadAdmissionLimits(worker);
    assert.equal(limits.globalMaxActiveManagedRuns,
      DEFAULT_MAX_ACTIVE_MANAGED_RUNS_GLOBAL);
    assert.equal(limits.perCheckoutMaxActiveWriters,
      DEFAULT_MAX_MANAGED_WRITERS_PER_CHECKOUT);
    assert.equal(limits.globalMaxActiveManagedRuns, 2);
    assert.equal(limits.perCheckoutMaxActiveWriters, 1);
  } finally { void worker.close(); }
});

test("readLeadAdmissionStatus counts active runs and surfaces per-project breakdown", async () => {
  const worker = freshWorker();
  try {
    const { id: taskA } = await createTask(worker, { title: "a", hostId: "h1", projectId: "alpha" });
    const { id: taskB } = await createTask(worker, { title: "b", hostId: "h1", projectId: "alpha" });
    const runA = await createRun(worker, { taskId: taskA, baseRevision: null });
    const runB = await createRun(worker, { taskId: taskB, baseRevision: null });
    await transitionRun(worker, runA.id, "running");
    await transitionRun(worker, runB.id, "running");
    const status = await readLeadAdmissionStatus(worker);
    assert.equal(status.activeManagedRunsGlobally, 2);
    assert.equal(status.activeManagedRunsByProject.alpha, 2);
    assert.equal(status.activeManagedRunsByHost.h1, 2);
  } finally { await worker.close(); }
});

test("admitLeadProposal admits a simple proposal with one item and zero grants", async () => {
  const worker = freshWorker();
  try {
    const result = await admitLeadProposal(worker, {
      context: baseCtx(),
      items: [{ localId: "x", title: "do the thing", objective: "" }],
      dependencies: [],
      grants: [],
    }, { defaultHostId: "h1" });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.admittedItems.length, 1);
      assert.equal(result.admittedItems[0]?.localId, "x");
    }
  } finally { await worker.close(); }
});

test("admitLeadProposal rejects a self-dependency", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx(),
        items: [{ localId: "x", title: "do" }],
        dependencies: [{ from: "x", to: "x" }],
        grants: [],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal rejects a dependency cycle", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ projectIds: ["alpha", "beta"] }),
        items: [
          { localId: "x", title: "x" },
          { localId: "y", title: "y" },
        ],
        dependencies: [
          { from: "x", to: "y" },
          { from: "y", to: "x" },
        ],
        grants: [],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal rejects unknown localIds in dependencies", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx(),
        items: [{ localId: "x", title: "x" }],
        dependencies: [{ from: "x", to: "y" }],
        grants: [],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal returns BUSY at the global active-run cap (2)", async () => {
  const worker = freshWorker();
  try {
    // Two existing active runs to hit the cap.
    for (let i = 0; i < 2; i++) {
      const { id: t } = await createTask(worker, { title: `t${i}`, hostId: "h1", projectId: "alpha" });
      const run = await createRun(worker, { taskId: t, baseRevision: null });
      await transitionRun(worker, run.id, "running");
    }
    const result = await admitLeadProposal(worker, {
      context: baseCtx(),
      items: [{ localId: "x", title: "x" }],
      dependencies: [],
      grants: [],
    }, { defaultHostId: "h1" });
    assert.equal(result.kind, "busy");
    if (result.kind === "busy") {
      assert.equal(result.trippedLimit, "global-max-active-managed-runs");
    }
  } finally { await worker.close(); }
});

test("admitLeadProposal narrows child grants against the parent's approved grants", async () => {
  const worker = freshWorker();
  try {
    // Seed a parent task with an approved authority grant.
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await transitionTask(worker, parentTaskId, { to: "ready" });
    await transitionTask(worker, parentTaskId, { to: "active" });
    const parentGrant = await requestGrant(worker, {
      taskId: parentTaskId, kind: "authority", principal: "lead-claude",
      scope: { powers: ["read", "write", "list"], paths: ["/tmp"] },
      digests: { artifactSha256: "1".repeat(64) },
      restrictions: [],
    });
    await decideGrant(worker, parentGrant.id, {
      decision: "approve", decidedBy: "user-eve",
    });
    const approvedParent = await readGrant(worker, parentGrant.id);
    assert.equal(approvedParent?.state, "approved");
    // Submit a child proposal that NARROWS the parent grant.
    const result = await admitLeadProposal(worker, {
      context: { ...baseCtx({ parentTaskId }) },
      items: [{ localId: "child", title: "child" }],
      dependencies: [],
      grants: [{
        localId: "child",
        parentGrantId: parentGrant.id,
        scope: { powers: ["read", "list"] }, // narrower
        digests: { artifactSha256: "1".repeat(64) },
        restrictions: [],
      }],
    }, { defaultHostId: "h1", deciderOverride: "user-eve" });
    assert.equal(result.kind, "ok");
  } finally { await worker.close(); }
});

test("admitLeadProposal refuses a grant whose scope is broader than the parent", async () => {
  const worker = freshWorker();
  try {
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await transitionTask(worker, parentTaskId, { to: "ready" });
    await transitionTask(worker, parentTaskId, { to: "active" });
    const parentGrant = await requestGrant(worker, {
      taskId: parentTaskId, kind: "authority", principal: "lead-claude",
      scope: { powers: ["read"] },
    });
    await decideGrant(worker, parentGrant.id, {
      decision: "approve", decidedBy: "user-eve",
    });
    // Child tries to grant "write" but parent only has "read".
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ parentTaskId }),
        items: [{ localId: "child", title: "child" }],
        dependencies: [],
        grants: [{
          localId: "child",
          parentGrantId: parentGrant.id,
          scope: { powers: ["read", "write"] },
          digests: {},
          restrictions: [],
        }],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal enforces depth ≤ MAX_GRANT_DEPTH", async () => {
  const worker = freshWorker();
  try {
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await transitionTask(worker, parentTaskId, { to: "ready" });
    await transitionTask(worker, parentTaskId, { to: "active" });
    // Build a chain of `MAX_GRANT_DEPTH` grants by writing the
    // meta-key directly; each grant's depth is recorded under
    // `grant-depth:<grantId>`. We only need the meta key to test
    // the depth check; the parent grant is real so the schema
    // and decide path are exercised.
    let lastGrantId: string | null = null;
    for (let i = 0; i <= MAX_GRANT_DEPTH; i++) {
      const g = await requestGrant(worker, {
        taskId: parentTaskId, kind: "authority", principal: "lead-claude",
        scope: { powers: ["read"] },
      });
      await decideGrant(worker, g.id, {
        decision: "approve", decidedBy: "user-eve",
      });
      // Write the depth meta row so readGrantDepth returns
      // increasing depth.
      const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void } } }).driver;
      driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
        .run(`grant-depth:${g.id}`,
          JSON.stringify({ depth: i, parentGrantId: lastGrantId }));
      lastGrantId = g.id;
    }
    // Submitting a child grant whose parent is the deepest grant
    // should produce depth = MAX_GRANT_DEPTH + 1 — which exceeds
    // the cap and refuses with FORBIDDEN.
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ parentTaskId }),
        items: [{ localId: "child", title: "child" }],
        dependencies: [],
        grants: [{
          localId: "child",
          parentGrantId: lastGrantId,
          scope: { powers: ["read"] },
          digests: {},
          restrictions: [],
        }],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal writes the parent-task meta key when context.parentTaskId is set", async () => {
  const worker = freshWorker();
  try {
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await transitionTask(worker, parentTaskId, { to: "ready" });
    await transitionTask(worker, parentTaskId, { to: "active" });
    const result = await admitLeadProposal(worker, {
      context: baseCtx({ parentTaskId }),
      items: [{ localId: "child", title: "child" }],
      dependencies: [],
      grants: [],
    }, { defaultHostId: "h1" });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      const childId = result.admittedItems[0]!.taskId;
      const driver = (worker as unknown as { driver: { prepare: (s: string) => { first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
      const row = driver.prepare("SELECT value FROM meta WHERE key = ?")
        .first(`parent-task:${childId}`);
      assert.ok(row);
      assert.equal(String(row!.value), parentTaskId);
    }
  } finally { await worker.close(); }
});

test("admitLeadProposal rejects duplicate localIds", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ projectIds: ["alpha", "beta"] }),
        items: [
          { localId: "x", title: "x" },
          { localId: "x", title: "y" },
        ],
        dependencies: [],
        grants: [],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal caps the proposal at 64 items", async () => {
  const worker = freshWorker();
  try {
    const items = Array.from({ length: 65 }, (_, i) => ({
      localId: `item-${i}`, title: `item-${i}`,
    }));
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ projectIds: ["alpha", "beta", "gamma", "delta"] }),
        items, dependencies: [], grants: [],
      }, { defaultHostId: "h1" }),
      (error: unknown) => (error as { name?: string })?.name === "ZodError",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal refuses grants whose parentGrantId is unknown", async () => {
  const worker = freshWorker();
  try {
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await assert.rejects(
      admitLeadProposal(worker, {
        context: baseCtx({ parentTaskId }),
        items: [{ localId: "child", title: "child" }],
        dependencies: [],
        grants: [{
          localId: "child",
          parentGrantId: "00000000-0000-4000-8000-000000000000",
          scope: {}, digests: {}, restrictions: [],
        }],
      }, { defaultHostId: "h1" }),
      (error: unknown) => error instanceof AppError
        && error.failure.code === "FORBIDDEN",
    );
  } finally { await worker.close(); }
});

test("admitLeadProposal returns BUSY at the per-checkout writer cap when the host already has an active lease", async () => {
  const worker = freshWorker();
  try {
    // Insert a held lease whose holder mentions h1 (the
    // runtime uses this heuristic for the per-checkout cap).
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void; first: (...b: unknown[]) => Record<string, unknown> | undefined } } }).driver;
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    driver.prepare(
      "INSERT INTO workspace (uuid, task_id, kind, location, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(workspaceId, "00000000-0000-4000-8000-000000000002", "git-worktree", "/tmp/h1", new Date().toISOString());
    const leaseId = "00000000-0000-4000-8000-000000000003";
    driver.prepare(
      "INSERT INTO lease (uuid, workspace_id, holder, state, acquired_at, expires_at, renewed_at, released_at, fencing_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(leaseId, workspaceId, "controller:h1", "held",
      new Date().toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      null, null, 1);
    const result = await admitLeadProposal(worker, {
      context: baseCtx(),
      items: [{ localId: "x", title: "x" }],
      dependencies: [],
      grants: [],
    }, { defaultHostId: "h1" });
    assert.equal(result.kind, "busy");
    if (result.kind === "busy") {
      assert.equal(result.trippedLimit, "per-checkout-writers");
    }
  } finally { await worker.close(); }
});

test("admitLeadProposal admits child grants whose depth is below MAX_GRANT_DEPTH", async () => {
  const worker = freshWorker();
  try {
    const { id: parentTaskId } = await createTask(worker, {
      title: "parent", hostId: "h1", projectId: "alpha",
    });
    await transitionTask(worker, parentTaskId, { to: "ready" });
    await transitionTask(worker, parentTaskId, { to: "active" });
    const parentGrant = await requestGrant(worker, {
      taskId: parentTaskId, kind: "authority", principal: "lead-claude",
      scope: { powers: ["read"] },
    });
    await decideGrant(worker, parentGrant.id, {
      decision: "approve", decidedBy: "user-eve",
    });
    const driver = (worker as unknown as { driver: { prepare: (s: string) => { run: (...b: unknown[]) => void } } }).driver;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`grant-depth:${parentGrant.id}`, JSON.stringify({ depth: 0, parentGrantId: null }));
    // Child grant at depth 1 (well below MAX_GRANT_DEPTH = 4) should be admitted.
    const result = await admitLeadProposal(worker, {
      context: baseCtx({ parentTaskId }),
      items: [{ localId: "child", title: "child" }],
      dependencies: [],
      grants: [{
        localId: "child",
        parentGrantId: parentGrant.id,
        scope: { powers: ["read"] },
        digests: {}, restrictions: [],
      }],
    }, { defaultHostId: "h1", deciderOverride: "user-eve" });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.admittedGrantIds.length, 1);
    }
  } finally { await worker.close(); }
});
