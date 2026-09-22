/**
 * M3c.2 — `verification_recipe`, `verification`, `review` services.
 *
 * Coverage:
 *  1. Recipe CRUD: create + read + listByProject + update bumps
 *     `configurationRevision` + delete.
 *  2. Recipe update that changes `command` rotates `configurationRevision`
 *     (the digest that binds a review); an unchanged recipe keeps the
 *     digest stable.
 *  3. Verification lifecycle: create → running → recordVerificationOutput
 *     → passed, captures identity triple + required check results.
 *  4. recordVerificationOutput refuses to overwrite a non-running row.
 *  5. Illegal verification transition (running → done) raises CONFLICT.
 *  6. Review `accept` requires all evidence verifications to be `passed`
 *     AND every required check within them to be `passed`.
 *  7. Review `accept` on a non-open review raises CONFLICT.
 *  8. Review `reject` works on any open review and stamps `decision`.
 *  9. `invalidateOpenReviewsForRun` flips every `open` review for the
 *     run to `invalidated` AND raises an `attention_item(kind: review)`
 *     per invalidated review.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import { createRun } from "../../src/runtime/db/runs";
import { AppError } from "../../src/shared/errors";
import { computeConfigurationRevision, createRecipe, deleteRecipe, listRecipesForProject, readRecipe, updateRecipe } from "../../src/runtime/db/verification-recipes";
import { createVerification, readVerification, recordVerificationOutput, transitionVerification } from "../../src/runtime/db/verifications";
import { acceptReview, createOpenReview, invalidateOpenReviewsForRun, listReviewsForTask, readReview, rejectReview } from "../../src/runtime/db/reviews";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function makeTaskAndRun(worker: DbWorker) {
  const { id: taskId } = await createTask(worker, { title: "t", hostId: "h1", projectId: "p1" });
  const run = await createRun(worker, { taskId });
  return { taskId, runId: run.id };
}

test("createRecipe/readRecipe/listRecipesForProject roundtrip", async () => {
  const worker = freshWorker();
  try {
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "unit tests", command: "npm",
      argv: ["test", "--colors=false"],
      env: { NODE_ENV: "test" },
      assertionPattern: "^\\{\"tests_total\":",
      required: true,
    });
    assert.equal(recipe.projectId, "p1");
    assert.equal(recipe.required, true);
    assert.equal(recipe.configurationRevision.length, 64);
    const reread = await readRecipe(worker, recipe.id);
    assert.deepEqual(reread, recipe);
    const list = await listRecipesForProject(worker, "p1");
    assert.equal(list.length, 1);
    const list2 = await listRecipesForProject(worker, "p2");
    assert.equal(list2.length, 0);
  } finally { await worker.close(); }
});

test("updateRecipe bumps configurationRevision when input changes; keeps it stable on no-op", async () => {
  const worker = freshWorker();
  try {
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "lint", command: "eslint",
      argv: ["src"], env: {},
    });
    const original = recipe.configurationRevision;
    // No-op update — `name` only is allowed; configurationRevision
    // is recomputed off (command, argv, env, assertionPattern, required).
    // Updating only `name` should NOT change the digest.
    const sameFields = await updateRecipe(worker, recipe.id, { name: "lint (renamed)" });
    assert.equal(sameFields.configurationRevision, original);
    // Changing `command` rotates the digest.
    const rotated = await updateRecipe(worker, recipe.id, { command: "tsc" });
    assert.notEqual(rotated.configurationRevision, original);
  } finally { await worker.close(); }
});

test("deleteRecipe removes the row", async () => {
  const worker = freshWorker();
  try {
    const recipe = await createRecipe(worker, {
      projectId: "p1", name: "x", command: "true", argv: [], env: {},
    });
    await deleteRecipe(worker, recipe.id);
    const reread = await readRecipe(worker, recipe.id);
    assert.equal(reread, undefined);
  } finally { await worker.close(); }
});

test("computeConfigurationRevision is order-independent on env and stable", () => {
  const a = computeConfigurationRevision({ command: "npm", argv: ["test"], env: { A: "1", B: "2" }, assertionPattern: null, required: true });
  const b = computeConfigurationRevision({ command: "npm", argv: ["test"], env: { B: "2", A: "1" }, assertionPattern: null, required: true });
  assert.equal(a, b);
  const c = computeConfigurationRevision({ command: "npm", argv: ["test"], env: { A: "1", B: "3" }, assertionPattern: null, required: true });
  assert.notEqual(a, c);
});

test("verification create → record output → passed", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v = await createVerification(worker, {
      taskId, runId, command: "echo", cwd: "/tmp",
      argv: ["hello"], env: {},
      candidateBase: "abcdef0", candidateTree: "abcdef1", candidateDiff: "d".repeat(64),
    });
    assert.equal(v.status, "running");
    assert.equal(v.requiredCheckResultsJson, "[]");
    const final = await recordVerificationOutput(worker, v.id, {
      exitCode: 0, signal: null,
      assertionCounts: { tests_total: 10, tests_passed: 10 },
      requiredCheckResults: [{ name: "echo", status: "passed", observed: "hello" }],
      stdoutTail: "hello\n", stderrTail: "",
      to: "passed",
    });
    assert.equal(final.status, "passed");
    assert.equal(final.exitCode, 0);
    assert.equal(final.endedAt !== null, true);
    const reloaded = await readVerification(worker, v.id);
    const results = JSON.parse(reloaded!.requiredCheckResultsJson) as Array<{ name: string; status: string }>;
    assert.equal(results[0]!.name, "echo");
    assert.equal(results[0]!.status, "passed");
  } finally { await worker.close(); }
});

test("recordVerificationOutput refuses to overwrite a non-running verification", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v = await createVerification(worker, { taskId, runId, command: "true", cwd: "/tmp" });
    await transitionVerification(worker, v.id, { to: "passed", exitCode: 0 });
    await assert.rejects(recordVerificationOutput(worker, v.id, {
      exitCode: 0, signal: null, assertionCounts: null,
      requiredCheckResults: [], stdoutTail: "", stderrTail: "", to: "passed",
    }), (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("transitionVerification refuses a second transition after the first terminal", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v = await createVerification(worker, { taskId, runId, command: "true", cwd: "/tmp" });
    await transitionVerification(worker, v.id, { to: "passed", exitCode: 0 });
    // Once `passed`, every transition is illegal (terminal).
    await assert.rejects(transitionVerification(worker, v.id, { to: "failed" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("acceptReview requires all evidence verifications to be passed AND every required check to be passed", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v1 = await createVerification(worker, { taskId, runId, command: "c1", cwd: "/tmp" });
    await recordVerificationOutput(worker, v1.id, {
      exitCode: 0, signal: null, assertionCounts: null,
      requiredCheckResults: [{ name: "c1", status: "passed" }],
      stdoutTail: "", stderrTail: "", to: "passed",
    });
    const v2 = await createVerification(worker, { taskId, runId, command: "c2", cwd: "/tmp" });
    await recordVerificationOutput(worker, v2.id, {
      exitCode: 1, signal: null, assertionCounts: null,
      requiredCheckResults: [{ name: "c2", status: "failed", observed: "assertion 1 failed" }],
      stdoutTail: "", stderrTail: "fail\n", to: "failed",
    });
    const review = await createOpenReview(worker, {
      taskId, runId,
      evidenceVerificationIds: [v1.id, v2.id],
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    await assert.rejects(acceptReview(worker, review.id, { decidedBy: "user-1" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
    // After dropping the failing verification, acceptance succeeds.
    const review2 = await createOpenReview(worker, {
      taskId, runId,
      evidenceVerificationIds: [v1.id],
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    const accepted = await acceptReview(worker, review2.id, { decidedBy: "user-1", decisionNote: "all green" });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.decision, "accepted");
    assert.equal(accepted.decidedBy, "user-1");
    assert.equal(accepted.decisionNote, "all green");
  } finally { await worker.close(); }
});

test("acceptReview on an already-accepted review raises CONFLICT", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v = await createVerification(worker, { taskId, runId, command: "c1", cwd: "/tmp" });
    await recordVerificationOutput(worker, v.id, {
      exitCode: 0, signal: null, assertionCounts: null,
      requiredCheckResults: [{ name: "c1", status: "passed" }],
      stdoutTail: "", stderrTail: "", to: "passed",
    });
    const review = await createOpenReview(worker, {
      taskId, runId,
      evidenceVerificationIds: [v.id],
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    await acceptReview(worker, review.id, { decidedBy: "user-1" });
    await assert.rejects(acceptReview(worker, review.id, { decidedBy: "user-1" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("rejectReview stamps decision on an open review", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const review = await createOpenReview(worker, {
      taskId, runId,
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    const rejected = await rejectReview(worker, review.id, { decidedBy: "user-1", decisionNote: "diff too big" });
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.decision, "rejected");
    const reread = await readReview(worker, review.id);
    assert.equal(reread?.status, "rejected");
  } finally { await worker.close(); }
});

test("invalidateOpenReviewsForRun flips open → invalidated and raises attention (review kind)", async () => {
  const worker = freshWorker();
  try {
    const { taskId, runId } = await makeTaskAndRun(worker);
    const v = await createVerification(worker, { taskId, runId, command: "c", cwd: "/tmp" });
    await recordVerificationOutput(worker, v.id, {
      exitCode: 0, signal: null, assertionCounts: null,
      requiredCheckResults: [{ name: "c", status: "passed" }],
      stdoutTail: "", stderrTail: "", to: "passed",
    });
    const review = await createOpenReview(worker, {
      taskId, runId, evidenceVerificationIds: [v.id],
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    const unrelated = await createOpenReview(worker, {
      taskId, runId: randomUUID(),
      candidateBase: "abcdef0", candidateTree: "abcdef1",
      candidateDiff: "e".repeat(64),
      configurationRevision: "f".repeat(64),
    });
    void unrelated;
    const result = await invalidateOpenReviewsForRun(worker, runId, "head-advanced");
    assert.equal(result.invalidated.length, 1);
    assert.equal(result.invalidated[0]!.id, review.id);
    assert.equal(result.attentionIds.length, 1);
    const reloaded = await readReview(worker, review.id);
    assert.equal(reloaded?.status, "invalidated");
    const reviews = await listReviewsForTask(worker, taskId);
    const invalidated = reviews.filter(r => r.status === "invalidated");
    assert.equal(invalidated.length, 1);
  } finally { await worker.close(); }
});
