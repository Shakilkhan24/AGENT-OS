/**
 * M3a Increment 2 — Lease gate + workspace preparation tests.
 *
 * Coverage:
 *  - prepareManagedWorkspace records a workspace + a held lease and
 *    returns a fencing token (M3a.2 / M3a.3 entry point).
 *  - checkLease allows a matching holder + token; rejects stale or
 *    mismatched tokens (M3a.3 mutation coordination).
 *  - assertLease throws LEASE_UNCERTAIN on expired / missing leases and
 *    CONFLICT on token mismatch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import {
  prepareManagedWorkspace, stubGitAdapter,
} from "../../src/runtime/db/workspace-prep";
import { readWorkspace } from "../../src/runtime/db/workspaces";
import { readActiveLease, markUncertain } from "../../src/runtime/db/leases";
import { checkLease, assertLease, mutateWithLease } from "../../src/runtime/db/lease-gate";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function makeTask(worker: DbWorker) {
  const { id } = await createTask(worker, { title: "x", hostId: "h1" });
  return id;
}

test("prepareManagedWorkspace records workspace + lease and returns a fence token", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const fakeHead = "fedcba9876543210".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeHead, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    assert.equal(result.fencingToken, 1);
    assert.equal(result.worktreePath, "/tmp/fake-worktree");
    assert.equal(result.baseCommit, fakeBase);
    assert.equal(result.headRevision, fakeHead);
    const ws = await readWorkspace(worker, result.workspaceId);
    assert.equal(ws?.leaseId, result.leaseId);
    const lease = await readActiveLease(worker, result.workspaceId);
    assert.equal(lease?.id, result.leaseId);
    assert.equal(lease?.holder, "controller-A");
  } finally { await worker.close(); }
});

test("checkLease accepts matching holder + token", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeBase, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    const check = await checkLease(worker, {
      workspaceId: result.workspaceId, holder: "controller-A", fencingToken: result.fencingToken,
    });
    assert.equal(check.ok, true);
  } finally { await worker.close(); }
});

test("checkLease rejects a stale token with reason 'mismatch'", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeBase, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    const check = await checkLease(worker, {
      workspaceId: result.workspaceId, holder: "controller-A", fencingToken: 999,
    });
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "mismatch");
  } finally { await worker.close(); }
});

test("checkLease rejects when the lease has been marked uncertain", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeBase, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    await markUncertain(worker, result.leaseId, { by: "controller-A" });
    const check = await checkLease(worker, {
      workspaceId: result.workspaceId, holder: "controller-A", fencingToken: result.fencingToken,
    });
    assert.equal(check.ok, false);
    if (!check.ok) assert.equal(check.reason, "missing");
  } finally { await worker.close(); }
});

test("assertLease throws LEASE_UNCERTAIN on a missing lease", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    // No lease acquired.
    await assert.rejects(assertLease(worker, {
      workspaceId: taskId, holder: "controller-A", fencingToken: 1,
    }), (error: unknown) => error instanceof AppError && error.failure.code === "LEASE_UNCERTAIN");
  } finally { await worker.close(); }
});

test("assertLease throws CONFLICT on a token mismatch", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeBase, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    await assert.rejects(assertLease(worker, {
      workspaceId: result.workspaceId, holder: "controller-A", fencingToken: 999,
    }), (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("mutateWithLease runs the body only when the lease is held", async () => {
  const worker = freshWorker();
  try {
    const taskId = await makeTask(worker);
    const fakeBase = "0123456789abcdef".repeat(4).slice(0, 40);
    const git = stubGitAdapter({ fakeBaseCommit: fakeBase, fakeHeadRevision: fakeBase, dirty: "" });
    const result = await prepareManagedWorkspace(worker, {
      taskId, repoDir: "/tmp/repo", baseCommit: fakeBase.slice(0, 7),
      worktreePath: "/tmp/repo/wt", holder: "controller-A", git,
    });
    let ran = false;
    await mutateWithLease(worker, {
      workspaceId: result.workspaceId, holder: "controller-A", fencingToken: result.fencingToken,
    }, async () => { ran = true; return "ok"; });
    assert.equal(ran, true);
  } finally { await worker.close(); }
});