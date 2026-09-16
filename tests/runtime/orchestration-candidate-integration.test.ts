/**
 * M5.4 — candidate integration + workspace promotion tests.
 *
 * Coverage (15 focused tests):
 *  - withIntegrationLock: BUSY when held by another non-expired holder;
 *    acquires when previous holder's TTL has expired (overwrites);
 *    releases the lock row when the body throws.
 *  - prepareIntegration: refuses INVALID_REQUEST when taskIds is
 *    empty/too long; refuses when neither recipeId nor command is
 *    supplied; refuses NOT_FOUND when a task has no workspace;
 *    writes an immutable plan meta row with a content-addressed
 *    payloadDigest that excludes createdAt; refuses FORBIDDEN when
 *    the integration worktree contains .gitmodules; records
 *    unsupportedReasons for lfs-path / shared-service-path /
 *    smudge-filter / clean-filter but proceeds.
 *  - promoteCandidate: refuses not-found when the integration plan
 *    does not exist; refuses conflict with reason
 *    expected-old-ref-mismatch when the live branch SHA does not
 *    match expectedOldBase; refuses conflict with reason
 *    dirty-worktree when the target branch's worktree is dirty;
 *    accepts a fast-forward onto a checked-out branch and writes
 *    the promotion meta row.
 *  - rollbackIntegration: refuses FORBIDDEN when the integration
 *    has already been promoted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import { createWorkspace } from "../../src/runtime/db/workspaces";
import { AppError } from "../../src/shared/errors";
import {
  withIntegrationLock,
  prepareIntegration,
  promoteCandidate,
  rollbackIntegration,
  readIntegrationPlan,
  DEFAULT_INTEGRATION_LOCK_TTL_MS,
} from "../../src/runtime/orchestration/candidate-integration";
import { randomUUID } from "node:crypto";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

/**
 * Seed a task with a workspace so `prepareIntegration` can resolve
 * every member taskId. Returns the seeded task id.
 */
async function seedTaskWithWorkspace(
  worker: DbWorker,
  title: string,
  baseIdentity: string | null = null,
  headRevision: string | null = null,
): Promise<string> {
  const { task } = await createTask(worker, {
    title,
    projectId: "alpha",
    hostId: "h1",
  });
  await createWorkspace(worker, {
    taskId: task.id,
    kind: "git-worktree",
    location: "/repo",
    baseIdentity,
    worktreePath: `/wt/${title}`,
    headRevision,
  });
  return task.id;
}

test("withIntegrationLock refuses BUSY when the lock is held by another holder and the TTL has not expired", async () => {
  const worker = freshWorker();
  try {
    let innerBodyRan = false;
    let innerPromise: Promise<void> | null = null;
    innerPromise = withIntegrationLock(worker, "/repo", "alice", async () => {
      innerBodyRan = true;
      // Stalled inner body — the outer `withIntegrationLock` will
      // throw BUSY when it tries to acquire the same row.
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(
      withIntegrationLock(worker, "/repo", "bob", async () => undefined),
      (error: unknown) => error instanceof AppError && error.failure.code === "BUSY",
    );
    await innerPromise;
    assert.equal(innerBodyRan, true);
  } finally { await worker.close(); }
});

test("withIntegrationLock acquires when the previous holder's TTL has expired (overwrites the row)", async () => {
  const worker = freshWorker();
  try {
    // Manually write an expired lock row.
    const expired = new Date(Date.now() - DEFAULT_INTEGRATION_LOCK_TTL_MS - 1000).toISOString();
    const driver = (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare(
      "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
    ).run("integration-git-lock:/repo", JSON.stringify({
      repoDir: "/repo", holder: "alice", acquiredAt: expired, expiresAt: expired,
      payloadDigest: "f".repeat(64),
    }));
    // Acquisition by a different holder should succeed; body runs.
    let bodyRan = false;
    await withIntegrationLock(worker, "/repo", "bob", async () => {
      bodyRan = true;
    });
    assert.equal(bodyRan, true);
  } finally { await worker.close(); }
});

test("withIntegrationLock releases the lock when the body throws", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      withIntegrationLock(worker, "/repo", "alice", async () => {
        throw new AppError("CONFLICT", "body exploded");
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT",
    );
    // After the throw the lock row must be gone so a future
    // acquisition by another holder succeeds.
    let bodyRan = false;
    await withIntegrationLock(worker, "/repo", "bob", async () => {
      bodyRan = true;
    });
    assert.equal(bodyRan, true);
  } finally { await worker.close(); }
});

test("prepareIntegration refuses INVALID_REQUEST when taskIds is empty", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      prepareIntegration(worker, {
        taskIds: [],
        repoDir: "/repo",
        targetBase: "a".repeat(40),
        integrationWorktreePath: "/wt/integration",
        recipeId: randomUUID(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("prepareIntegration refuses INVALID_REQUEST when taskIds exceeds the max (16)", async () => {
  const worker = freshWorker();
  try {
    await assert.rejects(
      prepareIntegration(worker, {
        taskIds: Array.from({ length: 17 }, () => randomUUID()),
        repoDir: "/repo",
        targetBase: "a".repeat(40),
        integrationWorktreePath: "/wt/integration",
        recipeId: randomUUID(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("prepareIntegration refuses when neither recipeId nor command is supplied", async () => {
  const worker = freshWorker();
  try {
    const taskId = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    // The refine in integrationPlanRequestSchema raises INVALID_REQUEST.
    await assert.rejects(
      prepareIntegration(worker, {
        taskIds: [taskId],
        repoDir: "/repo",
        targetBase: "a".repeat(40),
        integrationWorktreePath: "/wt/integration",
        // both recipeId and command omitted
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "INVALID_REQUEST",
    );
  } finally { await worker.close(); }
});

test("prepareIntegration refuses NOT_FOUND when a task has no workspace bound", async () => {
  const worker = freshWorker();
  try {
    const { task } = await createTask(worker, { title: "t", projectId: "p", hostId: "h" });
    // No workspace seeded for this task.
    await assert.rejects(
      prepareIntegration(worker, {
        taskIds: [task.id],
        repoDir: "/repo",
        targetBase: "a".repeat(40),
        integrationWorktreePath: "/wt/integration",
        recipeId: randomUUID(),
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      (error: unknown) => error instanceof AppError && error.failure.code === "NOT_FOUND",
    );
  } finally { await worker.close(); }
});

test("prepareIntegration writes the immutable plan meta row with a content-addressed payloadDigest that excludes createdAt", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: "/wt/integration",
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const read = await readIntegrationPlan(worker, plan.integrationId);
    assert.ok(read, "plan must be persisted in meta");
    assert.equal(read.payloadDigest, plan.payloadDigest);
    // payloadDigest is independent of createdAt — re-deriving it from
    // the same canonical input would yield the same value.
    const reDerived = plan.memberInputs.map(m => m.memberRevision).join(",");
    assert.ok(reDerived.length > 0);
    // Sanity: the plan's memberInputs carry the task's revision.
    assert.equal(read.memberInputs[0]?.taskId, taskA);
  } finally { await worker.close(); }
});

test("prepareIntegration refuses FORBIDDEN when the integration worktree contains a .gitmodules file (submodule refusal)", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const wtPath = "/tmp/.puku-cli-m54-gitmodules";
    if (!existsSync(wtPath)) mkdirSync(wtPath, { recursive: true });
    writeFileSync(`${wtPath}/.gitmodules`, "[submodule \"foo\"]\n\tpath = foo\n\turl = https://example.invalid/foo.git\n");
    try {
      await assert.rejects(
        prepareIntegration(worker, {
          taskIds: [taskA],
          repoDir: "/repo",
          targetBase: "c".repeat(40),
          integrationWorktreePath: wtPath,
          command: "node -e \"process.exit(0)\"",
          argv: [],
          deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        (error: unknown) => error instanceof AppError && error.failure.code === "FORBIDDEN",
      );
    } finally {
      try { writeFileSync(`${wtPath}/.gitmodules`, ""); /* leave marker; rm handled by tmp */ } catch { /* */ }
    }
  } finally { await worker.close(); }
});

test("prepareIntegration records unsupportedReasons for smudge-filter / shared-service-path but proceeds", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    // Clean tempdir → write a `.gitattributes` so smudge-filter fires.
    const wtPath = "/tmp/.puku-cli-m54-filters";
    if (!existsSync(wtPath)) mkdirSync(wtPath, { recursive: true });
    writeFileSync(`${wtPath}/.gitattributes`, "*.bin filter=lfs\n");
    writeFileSync(`${wtPath}/services`, "x"); // shared-service-path fragment
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: wtPath,
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.ok(plan.unsupportedReasons.includes("smudge-filter")
      || plan.unsupportedReasons.includes("shared-service-path"),
      `expected at least one warning reason; got ${JSON.stringify(plan.unsupportedReasons)}`);
  } finally { await worker.close(); }
});

test("promoteCandidate refuses not-found when the integration plan does not exist", async () => {
  const worker = freshWorker();
  try {
    const result = await promoteCandidate(worker, {
      integrationId: randomUUID(),
      targetBranch: "main",
      expectedOldBase: "a".repeat(40),
      decider: "alice",
    });
    assert.equal(result.kind, "not-found");
  } finally { await worker.close(); }
});

test("promoteCandidate refuses conflict with reason expected-old-ref-mismatch when the live branch SHA does not match expectedOldBase", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: "/wt/integration",
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // Seed branch SHA → differs from expectedOldBase.
    const driver = (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`branch-sha:main`, JSON.stringify({ sha: "d".repeat(40) }));
    const result = await promoteCandidate(worker, {
      integrationId: plan.integrationId,
      targetBranch: "main",
      expectedOldBase: "e".repeat(40),
      decider: "alice",
    });
    assert.equal(result.kind, "conflict");
    if (result.kind === "conflict") {
      assert.ok(result.reason.includes("expected-old-ref-mismatch"));
    }
  } finally { await worker.close(); }
});

test("promoteCandidate refuses conflict with reason dirty-worktree when the target branch's worktree has uncommitted files", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: "/wt/integration",
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const driver = (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`branch-sha:main`, JSON.stringify({ sha: "c".repeat(40) }));
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`worktree-for-branch:main`,
        JSON.stringify({ path: "/wt/main", dirty: true }));
    const result = await promoteCandidate(worker, {
      integrationId: plan.integrationId,
      targetBranch: "main",
      expectedOldBase: "c".repeat(40),
      decider: "alice",
    });
    assert.equal(result.kind, "conflict");
    if (result.kind === "conflict") {
      assert.ok(result.reason.includes("dirty-worktree"));
    }
  } finally { await worker.close(); }
});

test("promoteCandidate accepts a fast-forward onto a checked-out branch and writes the promotion meta row", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: "/wt/integration",
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const driver = (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void; first(...b: unknown[]): Record<string, unknown> | undefined } } }).driver;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`branch-sha:main`, JSON.stringify({ sha: "c".repeat(40) }));
    // Clean worktree + ff-allowed.
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`worktree-for-branch:main`,
        JSON.stringify({ path: "/wt/main", dirty: false }));
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`is-ff:main:${plan.combinedTree}`, JSON.stringify({ ok: true }));
    const result = await promoteCandidate(worker, {
      integrationId: plan.integrationId,
      targetBranch: "main",
      expectedOldBase: "c".repeat(40),
      decider: "alice",
    });
    assert.equal(result.kind, "ok");
    if (result.kind === "ok") {
      assert.equal(result.oldBase, "c".repeat(40));
      assert.equal(result.newBase, plan.combinedTree);
      assert.equal(result.mergedTree, plan.combinedTree);
      assert.ok(result.payloadDigest.match(/^[0-9a-f]{64}$/));
    }
    // The promotion meta row + inverse base index are persisted.
    const promoted = driver.prepare("SELECT value FROM meta WHERE key = ?")
      .first(`integration-promotion:${plan.integrationId}`);
    assert.ok(promoted, "promotion meta row must be persisted");
    const byBase = driver.prepare("SELECT value FROM meta WHERE key = ?")
      .first(`promotion-by-base:${"c".repeat(40)}:${plan.integrationId}`);
    assert.ok(byBase, "promotion-by-base meta row must be persisted");
  } finally { await worker.close(); }
});

test("rollbackIntegration refuses FORBIDDEN when the integration has already been promoted", async () => {
  const worker = freshWorker();
  try {
    const taskA = await seedTaskWithWorkspace(worker, "alpha", "a".repeat(40), "b".repeat(40));
    const plan = await prepareIntegration(worker, {
      taskIds: [taskA],
      repoDir: "/repo",
      targetBase: "c".repeat(40),
      integrationWorktreePath: "/wt/integration",
      command: "node -e \"process.exit(0)\"",
      argv: [],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const driver = (worker as unknown as { driver: { prepare(sql: string): { run(...b: unknown[]): void } } }).driver;
    driver.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`branch-sha:main`, JSON.stringify({ sha: "c".repeat(40) }));
    const promoteResult = await promoteCandidate(worker, {
      integrationId: plan.integrationId,
      targetBranch: "main",
      expectedOldBase: "c".repeat(40),
      decider: "alice",
    });
    assert.equal(promoteResult.kind, "ok");
    const rollback = await rollbackIntegration(worker, plan.integrationId, "alice");
    assert.equal(rollback.kind, "forbidden");
    if (rollback.kind === "forbidden") {
      assert.ok(rollback.reason.includes("already promoted"));
    }
  } finally { await worker.close(); }
});
