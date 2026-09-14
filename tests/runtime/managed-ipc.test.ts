/**
 * M3c.2 — `execute-verification` / `record-review-decision` IPC dispatcher
 * tests.
 *
 * We do NOT exercise the full runtime here — `RuntimeWorkspace` opens a
 * DB, an engine, etc. Instead, we wire a `ProtocolDispatcher` with the
 * same handler shape `workspace.ts` uses, register a stub `DbWorker`,
 * and confirm:
 *
 *  1. `execute-verification` resolves the task → workspace → recipe
 *     chain and returns an `{kind: "ok", verificationId, reviewId}`.
 *  2. `execute-verification` returns `{kind: "conflict", reason}` when
 *     the task has no workspace.
 *  3. `record-review-decision` rejects when no evidence is passed, and
 *     succeeds after evidence is recorded.
 *
 * The dispatcher uses the same Zod schemas as the IPC seam, so this is
 * also a guard that the schemas survive a round-trip through `parseRequest`
 * and `parseResult`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { API_VERSION, type Request } from "../../src/shared/protocol";
import { ProtocolDispatcher } from "../../src/main/protocol-dispatcher";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { verifyOnce } from "../../src/runtime/orchestration/verifier-execute";
import { acceptReview, createOpenReview, rejectReview } from "../../src/runtime/db/reviews";
import { createVerification, recordVerificationOutput } from "../../src/runtime/db/verifications";
import { createTask } from "../../src/runtime/db/tasks";
import { createWorkspace } from "../../src/runtime/db/workspaces";
import { createRecipe } from "../../src/runtime/db/verification-recipes";
import { AppError } from "../../src/shared/errors";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { PassThrough, type Readable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { setVerifierSpawn, resetVerifierSpawn } from "../../src/runtime/orchestration/verifier-execute";
import { configureLogging } from "../../src/main/logging";

configureLogging({ write: async () => {} });

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

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
  setImmediate(() => child.emit("exit", exit.code, exit.signal));
  return child;
}

function requestFor(method: string, args: unknown[]): Request {
  return {
    apiVersion: API_VERSION,
    id: crypto.randomUUID(),
    correlationId: crypto.randomUUID(),
    method: method as Request["method"],
    deadlineAt: Date.now() + 60_000,
    args,
  };
}

/** Build a dispatcher that mirrors `RuntimeWorkspace`'s IPC handler shape. */
async function dispatcherFor(worker: DbWorker) {
  const dispatcher = new ProtocolDispatcher();
  dispatcher.register("execute-verification", async ([taskId, recipeId, override]) => {
    try {
      const input: { taskId: string; recipeId?: string; command?: string; argv?: string[]; env?: Record<string, string>; deadlineAt: string } = {
        taskId,
        deadlineAt: new Date(Date.now() + 30_000).toISOString(),
      };
      if (recipeId) input.recipeId = recipeId;
      else if (override) {
        input.command = override.command;
        if (override.argv) input.argv = override.argv;
        if (override.env) input.env = override.env;
      }
      const result = await verifyOnce(worker, input);
      if (result.kind === "ok") return { kind: "ok" as const, verificationId: result.verificationId, reviewId: result.reviewId };
      return { kind: "conflict" as const, reason: result.reason };
    } catch (error) {
      if (error instanceof z.ZodError) {
        return { kind: "conflict" as const, reason: error.issues[0]?.message ?? "invalid input" };
      }
      if (error instanceof AppError) return { kind: "conflict" as const, reason: error.message };
      throw error;
    }
  });
  dispatcher.register("record-review-decision", async ([reviewId, decision, decidedBy]) => {
    try {
      const review = decision === "accept"
        ? await acceptReview(worker, reviewId, { decidedBy })
        : await rejectReview(worker, reviewId, { decidedBy });
      return { kind: "ok" as const, reviewId: review.id, status: review.status };
    } catch (error) {
      if (error instanceof AppError) return { kind: "conflict" as const, reason: error.message };
      throw error;
    }
  });
  return dispatcher;
}

test("IPC execute-verification returns ok with verificationId and reviewId", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    // Workspace on disk; the executor reads the porcelain digest from
    // a real worktree path.
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const worktreePath = await mkdtemp(`${tmpdir()}/minimal-ipc-wt-`);
    const ws = await createWorkspace(worker, {
      taskId, kind: "git-worktree", location: worktreePath,
      baseIdentity: "abcdef0", worktreePath, headRevision: "abcdef0",
    });
    void ws;
    const recipe = await createRecipe(worker, {
      projectId: "p", name: "echo-ok", command: "echo", argv: ["hi"], env: {},
    });
    setVerifierSpawn(() => fakeChild(Buffer.from("hi\n"), Buffer.from(""), { code: 0, signal: null }));
    try {
      const dispatcher = await dispatcherFor(worker);
      const response = await dispatcher.dispatch("execute-verification", requestFor("execute-verification", [taskId, recipe.id, null]));
      assert.equal(response.ok, true);
      if (!response.ok) throw new Error("expected ok");
      const result = response.result as { kind: "ok"; verificationId: string; reviewId: string };
      assert.equal(result.kind, "ok");
      assert.match(result.verificationId, /^[0-9a-f]{8}-/);
      assert.match(result.reviewId, /^[0-9a-f]{8}-/);
      await dispatcher.close();
    } finally { resetVerifierSpawn(); }
  } finally { await worker.close(); }
});

test("IPC execute-verification returns conflict when neither recipe nor override is supplied", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    const dispatcher = await dispatcherFor(worker);
    const response = await dispatcher.dispatch("execute-verification", requestFor("execute-verification", [taskId, null, null]));
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok");
    const result = response.result as { kind: "conflict"; reason: string };
    assert.equal(result.kind, "conflict");
    assert.match(result.reason, /recipeId or a command override/);
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC execute-verification returns conflict when the task has no workspace (override path)", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    const dispatcher = await dispatcherFor(worker);
    const response = await dispatcher.dispatch("execute-verification", requestFor("execute-verification", [
      taskId, null, { command: "echo", argv: ["hi"], env: {} },
    ]));
    assert.equal(response.ok, true);
    if (!response.ok) throw new Error("expected ok");
    const result = response.result as { kind: "conflict"; reason: string };
    assert.equal(result.kind, "conflict");
    assert.match(result.reason, /workspace/i);
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC execute-verification rejects a malformed recipeId", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    const dispatcher = await dispatcherFor(worker);
    const response = await dispatcher.dispatch("execute-verification", requestFor("execute-verification", [taskId, "not-a-uuid", null]));
    assert.equal(response.ok, false);
    if (response.ok) throw new Error("expected failure");
    assert.equal(response.error.code, "INVALID_REQUEST");
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC record-review-decision rejects an empty-evidence review and accepts a passing one", async () => {
  const worker = freshWorker();
  try {
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    const review = await createOpenReview(worker, {
      taskId,
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "0".repeat(64), configurationRevision: "1".repeat(64),
    });

    const dispatcher = await dispatcherFor(worker);
    // Empty evidence → conflict at the IPC seam.
    const empty = await dispatcher.dispatch("record-review-decision", requestFor("record-review-decision", [review.id, "accept", "user-1"]));
    assert.equal(empty.ok, true);
    if (!empty.ok) throw new Error("expected ok");
    const conflict = empty.result as { kind: "conflict"; reason: string } | { kind: "ok"; reviewId: string; status: string };
    assert.equal(conflict.kind, "conflict");

    // Record a passing verification and accept it through the IPC seam.
    const verification = await createVerification(worker, {
      taskId, recipeId: null, command: "echo", cwd: "/tmp",
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "0".repeat(64), configurationRevision: "1".repeat(64),
    });
    await recordVerificationOutput(worker, verification.id, {
      exitCode: 0, signal: null, assertionCounts: null,
      requiredCheckResults: [{ name: "echo", status: "passed", observed: "ok" }],
      stdoutTail: "", stderrTail: "", to: "passed",
    });

    // The review was opened without evidence — re-create one that binds to it.
    const bound = await createOpenReview(worker, {
      taskId,
      evidenceVerificationIds: [verification.id],
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "0".repeat(64), configurationRevision: "1".repeat(64),
    });

    const accepted = await dispatcher.dispatch("record-review-decision", requestFor("record-review-decision", [bound.id, "accept", "user-1"]));
    assert.equal(accepted.ok, true);
    if (!accepted.ok) throw new Error("expected ok");
    const ok = accepted.result as { kind: "ok"; reviewId: string; status: string };
    assert.equal(ok.kind, "ok");
    assert.equal(ok.status, "accepted");

    const rejected = await dispatcher.dispatch("record-review-decision", requestFor("record-review-decision", [bound.id, "reject", "user-1"]));
    assert.equal(rejected.ok, true);
    if (!rejected.ok) throw new Error("expected ok");
    // accept → terminal; reject from accepted is illegal.
    const rejection = rejected.result as { kind: "ok"; reviewId: string; status: string };
    assert.equal(rejection.kind, "conflict");

    // Reject another fresh open review.
    const fresh = await createOpenReview(worker, {
      taskId,
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "0".repeat(64), configurationRevision: "1".repeat(64),
    });
    const freshReject = await dispatcher.dispatch("record-review-decision", requestFor("record-review-decision", [fresh.id, "reject", "user-1"]));
    assert.equal(freshReject.ok, true);
    if (!freshReject.ok) throw new Error("expected ok");
    const freshResult = freshReject.result as { kind: "ok"; reviewId: string; status: string };
    assert.equal(freshResult.kind, "ok");
    assert.equal(freshResult.status, "rejected");

    void rejectReview; // avoid unused-import error
    await dispatcher.close();
  } finally { await worker.close(); }
});

// ───────── M3c.4 — `render-candidate-diff` dispatcher ────────────────────

test("IPC render-candidate-diff surfaces UNSUPPORTED_RESTRICTION for non-Git workspaces", async () => {
  const worker = freshWorker();
  try {
    // Same harness as the existing tests: a fresh dispatcher that mirrors
    // `RuntimeWorkspace`'s IPC handler shape. We re-register the new
    // method here so the test stays in this file (the M3c.4 dispatcher
    // handler in `workspace.ts` is the production twin).
    const { renderCandidateDiff } = await import("../../src/runtime/db/candidate-diff");
    const dispatcher = new ProtocolDispatcher();
    dispatcher.register("render-candidate-diff", async ([runId]) => {
      try {
        return await renderCandidateDiff(worker, { runId });
      } catch (error) {
        if (error instanceof AppError) throw new AppError("CONFLICT", error.message);
        throw error;
      }
    });
    const { id: taskId } = await createTask(worker, { title: "t", hostId: "h", projectId: "p" });
    await createWorkspace(worker, {
      taskId, kind: "snapshot", location: "/tmp/noworktree",
      baseIdentity: null, worktreePath: null, headRevision: null,
    });
    const { createRun } = await import("../../src/runtime/db/runs");
    const { id: runId } = await createRun(worker, { taskId, baseRevision: null });
    const response = await dispatcher.dispatch("render-candidate-diff",
      requestFor("render-candidate-diff", [runId]));
    assert.equal(response.ok, false);
    if (response.ok) throw new Error("expected failure");
    assert.equal(response.error.code, "CONFLICT");
    assert.match(response.error.message, /non-Git|UNSUPPORTED_RESTRICTION|worktree/i);
    await dispatcher.close();
  } finally { await worker.close(); }
});

test("IPC render-candidate-diff rejects a malformed runId at the protocol layer", async () => {
  const worker = freshWorker();
  try {
    const dispatcher = new ProtocolDispatcher();
    void worker;
    const response = await dispatcher.dispatch("render-candidate-diff",
      requestFor("render-candidate-diff", ["not-a-uuid"]));
    assert.equal(response.ok, false);
    if (response.ok) throw new Error("expected failure");
    assert.equal(response.error.code, "INVALID_REQUEST");
    await dispatcher.close();
  } finally { await worker.close(); }
});
