/**
 * M6.7 — operation manifest + recoverable staging tests.
 *
 * Coverage:
 *  1. `buildManifest` validates the schema (unique seq, contiguous
 *     range, overwrite requires content).
 *  2. `digestManifest` is deterministic; volatile `issuedAt` does
 *     NOT change the digest.
 *  3. `stageManifest` writes a snapshot to disk.
 *  4. `applyStagedManifest` runs every operation via the pool and
 *     finalises with `status: "applied"`.
 *  5. `applyStagedManifest` captures per-op failures as
 *     `partial` without aborting the loop.
 *  6. `cancelStagedManifest` flips the cancel flag; subsequent
 *     `applyStagedManifest` converges to `cancelled`.
 *  7. `loadStagedManifest` re-hydrates from disk.
 *  8. `FileWorkerPool` serialises operations from the same
 *     workspace and dispatches in parallel across workspaces.
 *  9. `FileWorkerPool` rejects invalid `size`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { AppError } from "../../src/shared/errors";
import {
  buildManifest,
  stageManifest,
  applyStagedManifest,
  loadStagedManifest,
  cancelStagedManifest,
  digestManifest,
  FileWorkerPool,
  resetStagingRegistry,
  operationManifestSchema,
} from "../../src/runtime/orchestration/operation-manifest";

async function freshStagingRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-m67-"));
  return {
    root,
    cleanup: async () => { await rm(root, { recursive: true, force: true }); },
  };
}

async function setupWorkspace(): Promise<{ ws: string; rootIdentity: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "minimal-m67-ws-"));
  // Seed files for the manifest to act on.
  await writeFile(path.join(dir, "old.txt"), "old", "utf8");
  await mkdir(path.join(dir, "nested"), { recursive: true });
  await writeFile(path.join(dir, "nested/inner.txt"), "x", "utf8");
  return {
    ws: dir,
    rootIdentity: "deadbeef",
    cleanup: async () => { await rm(dir, { recursive: true, force: true }); },
  };
}

test("M6.7 buildManifest validates overwrite requires content", () => {
  assert.throws(
    () => buildManifest({
      workspacePath: "/tmp/x",
      rootIdentity: "x",
      issuedBy: "x",
      operations: [{ kind: "overwrite", path: "a.txt", reason: "y" }],
    }),
    /content/i,
  );
});

test("M6.7 buildManifest enforces unique seq via schema, but buildManifest assigns contiguously", () => {
  const m = buildManifest({
    workspacePath: "/tmp/x",
    rootIdentity: "x",
    issuedBy: "tester",
    operations: [
      { kind: "delete", path: "a.txt", reason: "first" },
      { kind: "delete", path: "b.txt", reason: "second" },
      { kind: "delete", path: "c.txt", reason: "third" },
    ],
  });
  assert.deepEqual(m.operations.map((o) => o.seq), [1, 2, 3]);
});

test("M6.7 digestManifest is deterministic; issuedAt does not affect it", () => {
  const m1 = buildManifest({
    workspacePath: "/tmp/x", rootIdentity: "x", issuedBy: "tester",
    operations: [{ kind: "delete", path: "a.txt", reason: "x" }],
  });
  const m2 = { ...m1, issuedAt: new Date().toISOString() };
  assert.equal(digestManifest(m1), digestManifest(m2));
});

test("M6.7 digestManifest changes when the op list changes", () => {
  const a = buildManifest({
    workspacePath: "/tmp/x", rootIdentity: "x", issuedBy: "tester",
    operations: [{ kind: "delete", path: "a.txt", reason: "x" }],
  });
  const b = buildManifest({
    workspacePath: "/tmp/x", rootIdentity: "x", issuedBy: "tester",
    operations: [{ kind: "delete", path: "b.txt", reason: "x" }],
  });
  assert.notEqual(digestManifest(a), digestManifest(b));
});

test("M6.7 stageManifest writes a snapshot to disk", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  const ws = await setupWorkspace();
  try {
    const m = buildManifest({
      workspacePath: ws.ws, rootIdentity: ws.rootIdentity, issuedBy: "tester",
      operations: [{ kind: "delete", path: "old.txt", reason: "stale" }],
    });
    const { stagingDir } = await stageManifest(root.root, m);
    const raw = await readFile(path.join(stagingDir, "manifest.json"), "utf8");
    const json = JSON.parse(raw) as { status: string; nextApplied: number };
    assert.equal(json.status, "staged");
    assert.equal(json.nextApplied, 1);
  } finally { await root.cleanup(); await ws.cleanup(); }
});

test("M6.7 applyStagedManifest runs every operation and finalises applied", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  const ws = await setupWorkspace();
  try {
    const m = buildManifest({
      workspacePath: ws.ws, rootIdentity: ws.rootIdentity, issuedBy: "tester",
      operations: [
        { kind: "delete", path: "old.txt", reason: "stale" },
        { kind: "overwrite", path: "nested/inner.txt", content: "rewritten", reason: "patch" },
      ],
    });
    const { record } = await stageManifest(root.root, m);
    const final = await applyStagedManifest(root.root, record.manifest.manifestId, { pool: new FileWorkerPool() });
    assert.equal(final.status, "applied");
    assert.deepEqual(final.appliedSeqs, [1, 2]);
    assert.equal(final.errors[1], undefined);
    assert.equal(final.errors[2], undefined);
    // Verify filesystem effects.
    await assert.rejects(readFile(path.join(ws.ws, "old.txt"), "utf8"));
    assert.equal(await readFile(path.join(ws.ws, "nested/inner.txt"), "utf8"), "rewritten");
  } finally { await root.cleanup(); await ws.cleanup(); }
});

test("M6.7 applyStagedManifest captures per-op failures as partial", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  const ws = await setupWorkspace();
  try {
    const m = buildManifest({
      workspacePath: ws.ws, rootIdentity: ws.rootIdentity, issuedBy: "tester",
      operations: [
        { kind: "delete", path: "old.txt", reason: "ok" },
        // Operate on a path that escapes the workspace to trigger a
        // path-join that lands outside the workspace — defaults to
        // recursive delete which will succeed at the FS level but we
        // test overwrite of a directory, which fails.
        { kind: "overwrite", path: "nested", content: "no", reason: "bad" },
      ],
    });
    const { record } = await stageManifest(root.root, m);
    const final = await applyStagedManifest(root.root, record.manifest.manifestId, { pool: new FileWorkerPool() });
    assert.equal(final.status, "partial");
    assert.ok(final.errors[2]);
  } finally { await root.cleanup(); await ws.cleanup(); }
});

test("M6.7 cancelStagedManifest flips the cancel flag and converges to cancelled", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  const ws = await setupWorkspace();
  try {
    const m = buildManifest({
      workspacePath: ws.ws, rootIdentity: ws.rootIdentity, issuedBy: "tester",
      operations: [
        { kind: "delete", path: "old.txt", reason: "x" },
        { kind: "delete", path: "nested/inner.txt", reason: "x" },
      ],
    });
    const { record } = await stageManifest(root.root, m);
    const signal = { cancelled: false };
    cancelStagedManifest(record.manifest.manifestId, signal);
    const final = await applyStagedManifest(root.root, record.manifest.manifestId, { pool: new FileWorkerPool(), cancelSignal: signal });
    assert.equal(final.status, "cancelled");
  } finally { await root.cleanup(); await ws.cleanup(); }
});

test("M6.7 loadStagedManifest re-hydrates from disk after a fresh process", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  const ws = await setupWorkspace();
  try {
    const m = buildManifest({
      workspacePath: ws.ws, rootIdentity: ws.rootIdentity, issuedBy: "tester",
      operations: [{ kind: "delete", path: "old.txt", reason: "x" }],
    });
    await stageManifest(root.root, m);
    resetStagingRegistry(); // simulate process restart
    const rehydrated = await loadStagedManifest(root.root, m.manifestId);
    assert.ok(rehydrated);
    assert.equal(rehydrated!.status, "staged");
    assert.equal(rehydrated!.manifest.manifestId, m.manifestId);
  } finally { await root.cleanup(); await ws.cleanup(); }
});

test("M6.7 FileWorkerPool serialises operations from the same workspace", async () => {
  let active = 0;
  let maxActive = 0;
  const pool = new FileWorkerPool({
    size: 4,
    applyOperation: async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => setTimeout(r, 50));
      active -= 1;
    },
    revalidateRoot: async () => { /* noop */ },
  });
  const ws = "/tmp/same-ws";
  const m = buildManifest({
    workspacePath: ws, rootIdentity: "x", issuedBy: "tester",
    operations: [
      { kind: "noop", path: "a", reason: "x" },
      { kind: "noop", path: "b", reason: "x" },
      { kind: "noop", path: "c", reason: "x" },
    ],
  });
  await Promise.all([
    pool.submit(m, m.operations[0]),
    pool.submit(m, m.operations[1]),
    pool.submit(m, m.operations[2]),
  ]);
  // The wrap helper clears and refills but same-workspace
  // serialisation means max active for one workspace is 1; the
  // worker pool can still have other workspaces in flight. We
  // assert the pool never exceeded 1 active for THIS workspace.
  // Since the wrap logic shifts the queue per submission, the
  // maxActive we observe is what the pool ran concurrently.
  // With all three from the same workspace, max should be 1.
  // (The drain may have started one before the others were
  // queued — that's expected and acceptable.)
  assert.ok(maxActive <= 1, `expected same-workspace serialisation, got ${maxActive}`);
});

test("M6.7 FileWorkerPool rejects invalid size", () => {
  assert.throws(() => new FileWorkerPool({ size: 0 }), /positive integer/);
  assert.throws(() => new FileWorkerPool({ size: -1 }), /positive integer/);
  assert.throws(() => new FileWorkerPool({ size: 1.5 }), /positive integer/);
});

// ---------------------------------------------------------------------------
// M6.7 — "head-of-line blocking" adversarial surface
//
// The M6.7 spec mandates that the file-worker pool prevent
// head-of-line blocking: a slow workspace MUST NOT starve other
// workspaces. The pool's `drain` picks the workspace with the most
// pending ops (fair-share); per-workspace ordering is preserved,
// but cross-workspace ordering is NOT — a small workspace's op
// can run while a big workspace's queue is still draining.
//
// The tests below assert:
//   - workspace B's first op completes well before workspace A's
//     queue drains, even when A has many more ops;
//   - the pool's in-flight counter never exceeds `size`;
//   - mixing many ops across multiple workspaces interleaves
//     execution so no single workspace monopolises the slots.

test("M6.7 FileWorkerPool does not head-of-line block: a busy workspace cannot starve a quiet one", async () => {
  // Two workspaces. A submits 10 slow ops. B submits 1 fast op.
  // B's op MUST complete before A's queue has drained (i.e. while
  // A's ops are still pending). This proves the pool's drain
  // does not serialise across workspaces.
  const completionOrder: Array<{ workspace: string; seq: number }> = [];
  let active = 0;
  let maxActive = 0;
  const pool = new FileWorkerPool({
    size: 2,
    applyOperation: async (_manifest, op) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      // All ops take 100ms. With pool size 2, A's ops pair up
      // in serial batches; B's op must slip in.
      await new Promise<void>((r) => setTimeout(r, 100));
      active -= 1;
      completionOrder.push({ workspace: op.path.split("/")[0], seq: op.seq });
    },
    revalidateRoot: async () => { /* noop */ },
  });
  const manifestA = buildManifest({
    workspacePath: "/ws/a", rootIdentity: "x", issuedBy: "tester",
    operations: Array.from({ length: 10 }, (_, i) => ({
      kind: "delete" as const, path: `a/file-${i}`, reason: "x",
    })),
  });
  const manifestB = buildManifest({
    workspacePath: "/ws/b", rootIdentity: "y", issuedBy: "tester",
    operations: [{ kind: "delete" as const, path: "b/file", reason: "x" }],
  });
  const t0 = Date.now();
  await Promise.all([
    ...manifestA.operations.map((op) => pool.submit(manifestA, op)),
    pool.submit(manifestB, manifestB.operations[0]),
  ]);
  const elapsed = Date.now() - t0;
  // Find when B's op completed. With pool size 2 and 10 A-ops each
  // taking 100ms, total time = 1000ms (5 batches × 2 slots). B's
  // op must complete early — at most ~200ms (after the first batch
  // settles, the drain picks B's queue next because it has 1 op
  // and A still has 8).
  const bCompletionIdx = completionOrder.findIndex((c) => c.workspace === "b");
  assert.ok(bCompletionIdx >= 0, "B's op completed but is missing from the order");
  // The first ~100ms hosts the first 2 A-ops (size 2). After that,
  // B must be next — so bCompletionIdx must be ≤ 2 (i.e. within
  // the first batch of completions).
  assert.ok(bCompletionIdx <= 2,
    `B's op must complete before A's queue drains; got index ${bCompletionIdx} of ${completionOrder.length}`);
  // Sanity: pool never exceeded its size.
  assert.ok(maxActive <= 2, `pool exceeded size: ${maxActive}`);
  // Sanity: total time is bounded (no serial drain).
  assert.ok(elapsed < 1500, `expected concurrent execution (<1500ms), got ${elapsed}ms`);
});

test("M6.7 FileWorkerPool interleaves execution across multiple workspaces", async () => {
  // Three workspaces, each with 3 ops, pool size = 3. We submit
  // ops in a round-robin pattern (one from each workspace per
  // tick) so the QUEUES are populated across all three workspaces
  // before the drain dispatches. The completion order must NOT
  // be [A×3, B×3, C×3] (which would indicate workspace-level
  // serialisation). With round-robin drain, all three workspaces
  // interleave.
  const completionOrder: string[] = [];
  const pool = new FileWorkerPool({
    size: 3,
    applyOperation: async (_manifest, op) => {
      await new Promise<void>((r) => setTimeout(r, 50));
      completionOrder.push(op.path.split("/")[0]);
    },
    revalidateRoot: async () => { /* noop */ },
  });
  const make = (id: string) => buildManifest({
    workspacePath: `/ws/${id}`, rootIdentity: id, issuedBy: "tester",
    operations: [
      { kind: "delete" as const, path: `${id}/a`, reason: "x" },
      { kind: "delete" as const, path: `${id}/b`, reason: "x" },
      { kind: "delete" as const, path: `${id}/c`, reason: "x" },
    ],
  });
  const manifests = Object.fromEntries(
    ["alpha", "beta", "gamma"].map((id) => [id, make(id)]),
  );
  // Round-robin submit: alpha→beta→gamma, three rounds. After
  // this synchronous burst, every queue has 3 items and the pool
  // is fully saturated (inFlight === size).
  const submits: Array<Promise<void>> = [];
  for (let round = 0; round < 3; round++) {
    for (const id of ["alpha", "beta", "gamma"]) {
      submits.push(pool.submit(manifests[id], manifests[id].operations[round]));
    }
  }
  await Promise.all(submits);
  // All 9 ops must complete.
  assert.equal(completionOrder.length, 9);
  // The first 3 completions must include all three distinct
  // workspace IDs (proves the pool didn't serialise alpha's
  // queue before touching beta).
  const firstBatch = new Set(completionOrder.slice(0, 3));
  assert.equal(firstBatch.size, 3,
    `first 3 completions should cover 3 distinct workspaces; got ${[...firstBatch].join(",")}`);
});

test("M6.7 applyStagedManifest refuses a non-existent manifest with NOT_FOUND", async () => {
  resetStagingRegistry();
  const root = await freshStagingRoot();
  try {
    await assert.rejects(
      () => applyStagedManifest(root.root, "ghost", { pool: new FileWorkerPool() }),
      (error: unknown) => error instanceof AppError && error.failure.code === "NOT_FOUND",
    );
  } finally { await root.cleanup(); }
});

test("M6.7 operationManifestSchema refuses duplicate seq values", () => {
  assert.throws(() => operationManifestSchema.parse({
    manifestId: "x", workspacePath: "/tmp", rootIdentity: "x",
    issuedBy: "x", issuedAt: new Date().toISOString(),
    operations: [
      { seq: 1, kind: "delete", path: "a", content: null, reason: "x" },
      { seq: 1, kind: "delete", path: "b", content: null, reason: "x" },
    ],
  }), /unique/i);
});