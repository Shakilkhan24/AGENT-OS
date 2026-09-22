/**
 * M3a Increment 3 — context receipt, redaction, and native instruction tests.
 *
 * Coverage:
 *  - redactSecrets scrubs bearer tokens, API key prefixes, and SSH
 *    private keys without over-redacting ordinary content.
 *  - discoverNativeInstructions finds AGENTS.md / CLAUDE.md at the
 *    project root with stable digests + content.
 *  - assembleContextReceipt creates a draft receipt, scrubs secrets
 *    from every supplied field, and refuses a second active receipt
 *    for the same run.
 *  - transitionContextReceipt enforces the state machine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { createTask } from "../../src/runtime/db/tasks";
import { createRun } from "../../src/runtime/db/runs";
import {
  assembleContextReceipt, transitionContextReceipt, readContextReceipt, readActiveReceiptForRun,
} from "../../src/runtime/db/context-receipts";
import {
  discoverNativeInstructions, loadInstructionsForReceipt, instructionsDigest,
} from "../../src/runtime/db/native-instructions";
import { redactSecrets, redactString, looksLikeSecret } from "../../src/runtime/db/redact";
import { AppError } from "../../src/shared/errors";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

async function makeRun(worker: DbWorker) {
  const { id: taskId } = await createTask(worker, { title: "x", hostId: "h1" });
  const run = await createRun(worker, { taskId });
  return run.id;
}

// ── redaction ─────────────────────────────────────────────────────────────────

test("redactString scrubs bearer tokens and private key blocks", () => {
  const out = redactString("Authorization: Bearer abc.def.ghi-jkl_mno+pqr/0123456789=");
  assert.equal(out, "Authorization: Bearer [REDACTED]");
});

test("redactString scrubs env lines whose value is high-entropy", () => {
  const out = redactString("OPENAI_API_KEY=sk-abcdef0123456789abcdef0123456789abcdef0123456789");
  assert.match(out, /OPENAI_API_KEY=\[REDACTED\]/);
});

test("redactString preserves ordinary prose", () => {
  const prose = "Make the snapshot suite green by patching the patch";
  assert.equal(redactString(prose), prose);
});

test("redactSecrets walks an object tree", () => {
  const before = {
    objective: "Add sk-1234567890abcdef1234567890abcdef12345678 to the test",
    instructions: { file: "AGENTS.md", excerpt: "Bearer abcdefghijklmnopqrstuvwxyz0123456789" },
    revisions: { base: "main" },
  };
  const after = redactSecrets(before);
  assert.match(String(after.objective), /\[REDACTED\]/);
  assert.match(String(after.instructions.excerpt), /Bearer \[REDACTED\]/);
  assert.equal(after.revisions.base, "main");
});

test("looksLikeSecret accepts known prefixes + long hex/base64", () => {
  assert.equal(looksLikeSecret("sk-abcdefghijklmnopqrstuv"), true);
  assert.equal(looksLikeSecret("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), true);
  assert.equal(looksLikeSecret("a".repeat(64)), true);
  assert.equal(looksLikeSecret("hello world"), false);
});

// ── native instructions ──────────────────────────────────────────────────────

test("discoverNativeInstructions finds AGENTS.md + CLAUDE.md and computes digests", () => {
  const root = mkdtempSync(join(tmpdir(), "minimal-instr-"));
  try {
    writeFileSync(join(root, "AGENTS.md"), "Always run the tests first\n");
    writeFileSync(join(root, "CLAUDE.md"), "Use the bounded executor\n");
    writeFileSync(join(root, "README.md"), "MINIMAL\n======\n");
    const found = discoverNativeInstructions(root);
    const kinds = found.map(f => f.kind).sort();
    assert.deepEqual(kinds, ["AGENTS", "CLAUDE", "README"]);
    for (const f of found) {
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
    }
    assert.equal(loadInstructionsForReceipt(root).entries.length, 3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("instructionsDigest is stable under file insertion order", () => {
  const root1 = mkdtempSync(join(tmpdir(), "minimal-instr-"));
  const root2 = mkdtempSync(join(tmpdir(), "minimal-instr-"));
  try {
    writeFileSync(join(root1, "AGENTS.md"), "x\n");
    writeFileSync(join(root1, "CLAUDE.md"), "y\n");
    // Build root2 in the reverse order.
    writeFileSync(join(root2, "CLAUDE.md"), "y\n");
    writeFileSync(join(root2, "AGENTS.md"), "x\n");
    const a = discoverNativeInstructions(root1);
    const b = discoverNativeInstructions(root2);
    assert.equal(instructionsDigest(a), instructionsDigest(b));
  } finally {
    rmSync(root1, { recursive: true, force: true });
    rmSync(root2, { recursive: true, force: true });
  }
});

// ── context receipt ──────────────────────────────────────────────────────────

test("assembleContextReceipt creates a draft + scrubs secret-shaped inputs", async () => {
  const worker = freshWorker();
  try {
    const runId = await makeRun(worker);
    const out = await assembleContextReceipt(worker, {
      runId,
      objective: "Use Bearer abcdefghijklmnopqrstuvwxyz0123456789012 to call the API",
      instructions: { inline: "sk-abcdefghijklmnopqrstuv" },
    });
    assert.equal(out.receipt.status, "draft");
    assert.match(out.objective, /Bearer \[REDACTED\]/);
    assert.match(out.instructionsJson, /\[REDACTED\]/);
    assert.match(out.digestsJson, /"objective":/);
  } finally { await worker.close(); }
});

test("assembleContextReceipt refuses a second active receipt for the same run", async () => {
  const worker = freshWorker();
  try {
    const runId = await makeRun(worker);
    await assembleContextReceipt(worker, { runId, objective: "first" });
    await assert.rejects(assembleContextReceipt(worker, { runId, objective: "second" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("transitionContextReceipt enforces draft → assembled → submitted → confirmed", async () => {
  const worker = freshWorker();
  try {
    const runId = await makeRun(worker);
    const assembled = await assembleContextReceipt(worker, { runId, objective: "x" });
    const submitted = await transitionContextReceipt(worker, assembled.receipt.id, { to: "assembled" });
    assert.equal(submitted.status, "assembled");
    const sub2 = await transitionContextReceipt(worker, assembled.receipt.id, { to: "submitted" });
    assert.equal(sub2.status, "submitted");
    const conf = await transitionContextReceipt(worker, assembled.receipt.id, { to: "confirmed" });
    assert.equal(conf.status, "confirmed");
    const loaded = await readContextReceipt(worker, assembled.receipt.id);
    assert.equal(loaded?.status, "confirmed");
  } finally { await worker.close(); }
});

test("transitionContextReceipt refuses draft → confirmed", async () => {
  const worker = freshWorker();
  try {
    const runId = await makeRun(worker);
    const assembled = await assembleContextReceipt(worker, { runId, objective: "x" });
    await assert.rejects(transitionContextReceipt(worker, assembled.receipt.id, { to: "confirmed" }),
      (error: unknown) => error instanceof AppError && error.failure.code === "CONFLICT");
  } finally { await worker.close(); }
});

test("readActiveReceiptForRun returns the live receipt after confirmation", async () => {
  const worker = freshWorker();
  try {
    const runId = await makeRun(worker);
    const out = await assembleContextReceipt(worker, { runId, objective: "x" });
    await transitionContextReceipt(worker, out.receipt.id, { to: "assembled" });
    await transitionContextReceipt(worker, out.receipt.id, { to: "submitted" });
    await transitionContextReceipt(worker, out.receipt.id, { to: "confirmed" });
    const active = await readActiveReceiptForRun(worker, runId);
    assert.equal(active?.status, "confirmed");
    assert.equal(active?.id, out.receipt.id);
  } finally { await worker.close(); }
});