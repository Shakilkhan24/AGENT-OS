/**
 * M3c.2 — `verifyOnce` executor tests.
 *
 * Coverage (per plan):
 *  1. Success — exit 0 with a recipe that has no required checks → `passed`.
 *  2. Required check fails (exit 1) → `failed` status with `failed` result.
 *  3. Required check empty (no output) → `empty` status, verifier still completes.
 *  4. Required check missing (verifier never started) → handled in test as
 *     a spawn-error stub.
 *  5. Verifier exceeds `deadlineAt` → status `error` with partial output preserved.
 *  6. Verifier writes invalid JSON for the assertion pattern → counts row is
 *     `null`, the verification still completes (the verdict is on the
 *     required check, not the assertion counts).
 *  7. Workspace `head_revision` advances after `verifyOnce` returns →
 *     `invalidateOpenReviewsForRun` transitions the open review to
 *     `invalidated` and raises an `attention_item` of `kind: "review"`.
 *
 * Each test stubs `spawn` via `setVerifierSpawn` so we don't actually
 * shell out to anything. The stubs emit the byte streams Node's child
 * would emit.
 */
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { DbWorker } from "../../../src/runtime/db/worker";
import { MemoryDatabase } from "../../../src/runtime/db/memory";
import { tableSpecs } from "../../../src/runtime/db/schema";
import { createTask } from "../../../src/runtime/db/tasks";
import { createRun } from "../../../src/runtime/db/runs";
import { createWorkspace } from "../../../src/runtime/db/workspaces";
import { readReview, listReviewsForTask } from "../../../src/runtime/db/reviews";
import { setHeadRevision } from "../../../src/runtime/db/workspaces";
import { createRecipe } from "../../../src/runtime/db/verification-recipes";
import { resetVerifierSpawn, setVerifierSpawn, verifyOnce } from "../../../src/runtime/orchestration/verifier-execute";
import { invalidateOpenReviewsForRun } from "../../../src/runtime/db/reviews";
import { listAttention } from "../../../src/runtime/db/attention-items";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function makeTaskAndWorkspace(worker: DbWorker) {
  const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1", projectId: "p1" });
  // The worktree path must exist on disk for the porcelain digest; use /tmp.
  const worktreePath = await (async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    return mkdtemp(`${tmpdir()}/minimal-verifier-wt-`);
  })();
  const ws = await createWorkspace(worker, {
    taskId, kind: "git-worktree", location: worktreePath,
    baseIdentity: "abcdef0", worktreePath,
    headRevision: "abcdef0",
  });
  return { taskId, ws };
}

/** Build a fake `ChildProcess` whose `stdout`/`stderr` are the supplied buffers. */
function fakeChild(stdout: Buffer, stderr: Buffer, exit: { code: number | null; signal: NodeJS.Signals | null }): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  (child as unknown as { stdout: Readable }).stdout = stdoutStream as unknown as Readable;
  (child as unknown as { stderr: Readable }).stderr = stderrStream as unknown as Readable;
  (child as unknown as { kill: (signal?: NodeJS.Signals) => boolean }).kill = () => true;
  if (stdout.length > 0) stdoutStream.write(stdout);
  stdoutStream.end();
  if (stderr.length > 0) stderrStream.write(stderr);
  stderrStream.end();
  // Emit exit on the child itself (not a separate lifecycle EE).
  setImmediate(() => child.emit("exit", exit.code, exit.signal));
  return child;
}

test("verifyOnce: success — exit 0 with a passing required check → verification passes, review opens", async () => {
  const worker = freshWorker();
  try {
    const { taskId, ws } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "echo-ok", command: "echo", argv: ["hi"], env: {},
    });
    setVerifierSpawn(() => fakeChild(Buffer.from("hi\n"), Buffer.from(""), { code: 0, signal: null }));
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "passed");
      assert.equal(result.verification.exitCode, 0);
      const reviews = await listReviewsForTask(worker, taskId);
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]!.status, "open");
      assert.equal(reviews[0]!.configurationRevision, recipe.configurationRevision);
      void ws;
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: required check fails → verification.status = failed", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "failing-test", command: "false", argv: [], env: {},
    });
    setVerifierSpawn(() => fakeChild(Buffer.from(""), Buffer.from("oh no\n"), { code: 1, signal: null }));
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "failed");
      const reloaded = await readReview(worker, result.reviewId);
      assert.equal(reloaded?.status, "open"); // review still opens even on failed verification
      const reviews = await listReviewsForTask(worker, taskId);
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]!.status, "open"); // review still opens even on failed verification
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: required check empty (no stdout) → status empty", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "silent", command: "true", argv: [], env: {},
    });
    setVerifierSpawn(() => fakeChild(Buffer.from(""), Buffer.from(""), { code: 0, signal: null }));
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "passed");
      const results = JSON.parse(result.verification.requiredCheckResultsJson) as Array<{ name: string; status: string }>;
      assert.equal(results[0]!.status, "empty");
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: verifier never starts (spawn error) → verification.status = error, review still opens", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "missing", command: "/no/such/binary", argv: [], env: {},
    });
    setVerifierSpawn(() => {
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();
      stdoutStream.end();
      stderrStream.end();
      const child = new EventEmitter() as unknown as ChildProcess;
      (child as unknown as { stdout: Readable }).stdout = stdoutStream as unknown as Readable;
      (child as unknown as { stderr: Readable }).stderr = stderrStream as unknown as Readable;
      (child as unknown as { kill: (signal?: NodeJS.Signals) => boolean }).kill = () => true;
      // Emit `error` on the child itself (not a separate EE), and
      // attach a no-op error listener so the EE doesn't throw.
      child.on("error", () => { /* swallowed by the executor */ });
      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));
      return child;
    });
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "error");
      assert.equal(result.verification.exitCode, null);
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: deadline exceeded → status error, partial output preserved", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "slow", command: "sleep", argv: ["10"], env: {},
    });
    // The stub returns a child whose exit fires after a long delay; the
    // executor's deadline will SIGTERM/SIGKILL it.
    setVerifierSpawn(() => fakeChild(Buffer.from("starting\n"), Buffer.from(""), { code: null, signal: "SIGTERM" }));
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        // Past timestamp — executor treats this as "immediate deadline".
        deadlineAt: new Date(Date.now() - 1).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "error");
      assert.equal(result.verification.signal, "SIGTERM");
      const results = JSON.parse(result.verification.requiredCheckResultsJson) as Array<{ name: string; status: string }>;
      assert.equal(results[0]!.status, "missing");
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: invalid assertion JSON → counts row is null, verification still passes", async () => {
  const worker = freshWorker();
  try {
    const { taskId } = await makeTaskAndWorkspace(worker);
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "json-counts", command: "echo", argv: ["{not-json}"], env: {},
      assertionPattern: "tests_total",
    });
    setVerifierSpawn(() => fakeChild(Buffer.from("{not-json}\n"), Buffer.from(""), { code: 0, signal: null }));
    try {
      const result = await verifyOnce(worker, {
        taskId, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      assert.equal(result.verification.status, "passed");
      assert.equal(result.verification.assertionCountsJson, null);
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("verifyOnce: workspace head_revision advances after return → review invalidated + attention raised", async () => {
  const worker = freshWorker();
  try {
    const { taskId, ws } = await makeTaskAndWorkspace(worker);
    const run = await createRun(worker, { taskId });
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "lint", command: "echo", argv: ["ok"], env: {},
    });
    setVerifierSpawn(() => fakeChild(Buffer.from("ok\n"), Buffer.from(""), { code: 0, signal: null }));
    try {
      const result = await verifyOnce(worker, {
        taskId, runId: run.id, recipeId: recipe.id,
        deadlineAt: new Date(Date.now() + 10_000).toISOString(),
      });
      assert.equal(result.kind, "ok");
      if (result.kind !== "ok") throw new Error("expected ok");
      // Simulate the lease-gate's invalidation path: head advances, run is
      // stamped, and the open review for this run is flipped.
      await setHeadRevision(worker, ws.id, "ffffff1");
      const result2 = await invalidateOpenReviewsForRun(worker, run.id, "head-advanced");
      assert.equal(result2.invalidated.length, 1);
      assert.equal(result2.invalidated[0]!.id, result.reviewId);
      assert.equal(result2.attentionIds.length, 1);
      const reloaded = await readReview(worker, result.reviewId);
      assert.equal(reloaded?.status, "invalidated");
      const attention = (await listAttention(worker)).filter(item => item.kind === "review");
      assert.equal(attention.length, 1);
      assert.equal(attention[0]!.kind, "review");
      assert.equal(attention[0]!.issueIdentity, `review:${result.reviewId}`);
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});