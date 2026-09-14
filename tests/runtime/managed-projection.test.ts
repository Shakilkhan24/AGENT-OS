/**
 * M3c.1 — managed projection tests.
 *
 * Coverage:
 *  1. `buildManagedProjection(undefined)` returns `{available: false,
 *     reason: "db-closed"}`.
 *  2. An empty worker (no tasks, no runs, no events) returns a populated
 *     `ManagedProjection` with empty arrays.
 *  3. A populated worker with one task → one run → one invocation →
 *     one dispatch intent projects each entity into its view shape
 *     and pre-groups tasks by `projectId`.
 *  4. Multiple runs on the same task appear as separate `runView` rows;
 *     the `invocationCount` aggregate reflects the number of
 *     invocations per run.
 *  5. Closed attention items appear under the projection; open items do not.
 *  6. A schema-mismatch (no schema applied) returns
 *     `{available: false, reason: "schema-mismatch"}`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { buildManagedProjection } from "../../src/runtime/managed-projection";
import { createTask, transitionTask } from "../../src/runtime/db/tasks";
import { createRun, transitionRun } from "../../src/runtime/db/runs";
import { createInvocation, transitionInvocation } from "../../src/runtime/db/invocations";
import { recordDispatchIntent, transitionDispatchIntent } from "../../src/runtime/db/dispatch-intents";
import { raiseAttention, transitionAttention } from "../../src/runtime/db/attention-items";
import { createWorkspace } from "../../src/runtime/db/workspaces";
import { acquireLease } from "../../src/runtime/db/leases";
import { pinArtifact } from "../../src/runtime/db/artifact-references";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

test("buildManagedProjection returns db-closed when no worker is provided", async () => {
  const projection = await buildManagedProjection(undefined);
  assert.equal(projection.available, false);
  if (projection.available === false) {
    assert.equal(projection.reason, "db-closed");
  } else { throw new Error("expected unavailable projection"); }
});

test("buildManagedProjection returns schema-mismatch when the schema has not been applied", async () => {
  // Bare in-memory database with no DDL — `takeSnapshot` will throw on
  // the missing `meta` table.
  const worker = new DbWorker({ driver: new MemoryDatabase() });
  try {
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, false);
    if (projection.available === false) {
      assert.equal(projection.reason, "schema-mismatch");
    } else { throw new Error("expected unavailable projection"); }
  } finally { await worker.close(); }
});

test("buildManagedProjection on an empty worker returns the available envelope with empty arrays", async () => {
  const worker = freshWorker();
  try {
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, true);
    if (projection.available === true) {
      assert.equal(projection.projectGroups.length, 0);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.invocations.length, 0);
      assert.equal(projection.dispatchIntents.length, 0);
      assert.equal(projection.leases.length, 0);
      assert.equal(projection.grants.length, 0);
      assert.equal(projection.contextReceipts.length, 0);
      assert.equal(projection.artifacts.length, 0);
      assert.equal(projection.closedAttention.length, 0);
      assert.equal(projection.stream.length, 0);
      // generatedAt is an ISO string close to "now".
      assert.match(projection.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    } else { throw new Error("expected available projection"); }
  } finally { await worker.close(); }
});

test("buildManagedProjection projects task → run → invocation → dispatch intent with project grouping", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, {
      title: "Fix the failing test",
      objective: "Make the snapshot suite green",
      projectId: "minimal",
      hostId: "devbox-01",
      providerVersion: "claude-1.0",
      model: "claude-opus",
      accountMode: "authenticated",
    });
    await transitionTask(worker, taskId, { to: "ready" });
    const run = await createRun(worker, { taskId, baseRevision: "abcdef0" });
    await transitionRun(worker, run.id, "running");
    const digest = "a".repeat(64);
    const invocation = await createInvocation(worker, {
      runId: run.id, idempotencyKey: "k1", canonicalDigest: digest,
      providerVersion: "v1", model: "m1", accountMode: "authenticated",
    });
    await transitionInvocation(worker, invocation.id, { to: "admitted" });
    await transitionInvocation(worker, invocation.id, { to: "spawned" });
    const intent = await recordDispatchIntent(worker, {
      runId: run.id, invocationId: invocation.id,
      method: "executeOnce", deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await transitionDispatchIntent(worker, intent.id, "claimed");
    await transitionDispatchIntent(worker, intent.id, "spawned");
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, true);
    if (projection.available !== true) throw new Error("expected available projection");
    assert.equal(projection.projectGroups.length, 1);
    const group = projection.projectGroups[0]!;
    assert.equal(group.projectId, "minimal");
    assert.equal(group.tasks.length, 1);
    assert.equal(group.tasks[0]!.title, "Fix the failing test");
    assert.equal(group.tasks[0]!.status, "ready");
    assert.equal(projection.runs.length, 1);
    assert.equal(projection.runs[0]!.status, "running");
    assert.equal(projection.runs[0]!.invocationCount, 1);
    assert.equal(projection.invocations.length, 1);
    assert.equal(projection.invocations[0]!.idempotencyKey, "k1");
    assert.equal(projection.invocations[0]!.status, "spawned");
    assert.equal(projection.dispatchIntents.length, 1);
    assert.equal(projection.dispatchIntents[0]!.state, "spawned");
    assert.equal(projection.dispatchIntents[0]!.method, "executeOnce");
  } finally { await worker.close(); }
});

test("buildManagedProjection reports invocationCount per run and groups tasks by project", async () => {
  const worker = freshWorker();
  try {
    const { id: taskA } = await createTask(worker, { title: "A", hostId: "h1", projectId: "p1" });
    const { id: taskB } = await createTask(worker, { title: "B", hostId: "h1", projectId: "p2" });
    const runA = await createRun(worker, { taskId: taskA });
    const runB = await createRun(worker, { taskId: taskB });
    // Two invocations on runA, one on runB.
    const invA1 = await createInvocation(worker, {
      runId: runA.id, idempotencyKey: "k1", canonicalDigest: "a".repeat(64),
      providerVersion: "v", model: "m", accountMode: "authenticated",
    });
    await createInvocation(worker, {
      runId: runA.id, idempotencyKey: "k2", canonicalDigest: "b".repeat(64),
      providerVersion: "v", model: "m", accountMode: "authenticated",
    });
    const invB = await createInvocation(worker, {
      runId: runB.id, idempotencyKey: "k3", canonicalDigest: "c".repeat(64),
      providerVersion: "v", model: "m", accountMode: "authenticated",
    });
    void invA1; void invB;
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, true);
    if (projection.available !== true) throw new Error("expected available projection");
    assert.equal(projection.projectGroups.length, 2);
    const groups = new Map(projection.projectGroups.map(g => [g.projectId, g.tasks]));
    assert.equal(groups.get("p1")!.length, 1);
    assert.equal(groups.get("p2")!.length, 1);
    const runAView = projection.runs.find(r => r.id === runA.id);
    const runBView = projection.runs.find(r => r.id === runB.id);
    assert.equal(runAView?.invocationCount, 2);
    assert.equal(runBView?.invocationCount, 1);
    assert.equal(projection.invocations.length, 3);
  } finally { await worker.close(); }
});

test("buildManagedProjection includes closed attention items only; open ones are filtered out", async () => {
  const worker = freshWorker();
  try {
    const closed = await raiseAttention(worker, { kind: "decision", issueIdentity: "issue-closed", revision: 1 });
    await raiseAttention(worker, { kind: "decision", issueIdentity: "issue-open", revision: 1 });
    await transitionAttention(worker, closed.id, "seen");
    await transitionAttention(worker, closed.id, "resolved");
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, true);
    if (projection.available !== true) throw new Error("expected available projection");
    assert.equal(projection.closedAttention.length, 1);
    assert.equal(projection.closedAttention[0]!.issueIdentity, "issue-closed");
  } finally { await worker.close(); }
});

test("buildManagedProjection projects a workspace lease and a pinned artifact", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1" });
    const ws = await createWorkspace(worker, {
      taskId, kind: "git-worktree", location: "/tmp/wt",
      baseIdentity: "abcdef0", worktreePath: "/tmp/wt", headRevision: "abcdef0",
    });
    const lease = await acquireLease(worker, {
      workspaceId: ws.id, holder: "controller-1", ttlMs: 60_000,
    });
    // `pinArtifact` exercises the flat lister; grants are not exercised
    // here because `requestGrant` calls `probeCapabilities()` and would
    // require a stub seam. Grant projection is covered indirectly by
    // the empty-grants assertion in the empty-worker test above.
    await pinArtifact(worker, {
      taskId, uri: "file:///tmp/example.txt", sha256: "a".repeat(64),
      kind: "context", bytes: 12, mime: "text/plain",
    });
    void pinArtifact;
    const projection = await buildManagedProjection(worker);
    assert.equal(projection.available, true);
    if (projection.available !== true) throw new Error("expected available projection");
    assert.equal(projection.leases.length, 1);
    assert.equal(projection.leases[0]!.id, lease.id);
    assert.equal(projection.leases[0]!.state, "held");
    assert.equal(projection.leases[0]!.workspaceId, ws.id);
    assert.equal(projection.artifacts.length, 1);
    assert.equal(projection.artifacts[0]!.uri, "file:///tmp/example.txt");
    assert.equal(projection.grants.length, 0);
  } finally { await worker.close(); }
});
