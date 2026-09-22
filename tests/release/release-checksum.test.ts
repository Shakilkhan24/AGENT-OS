/**
 * M9.2 — release integrity-manifest round-trip test.
 *
 * Covers:
 *  - `writeIntegrityManifest` produces a sorted `MANIFEST.sha256` that
 *    excludes itself and the `.package.lock` flock file.
 *  - `verifyIntegrityManifest` accepts the manifest immediately after
 *    it is written.
 *  - Tampering one byte in any file flips `ok` to `false` with
 *    `reason: "DIGEST_MISMATCH"`.
 *  - Removing a file flips `ok` to `false` with
 *    `reason: "ENTRY_MISSING"`.
 *  - The manifest lines are sorted lexicographically so a tree that
 *    diffs by path-only can be checked visually.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  writeIntegrityManifest,
  verifyIntegrityManifest,
} from "../../scripts/release.mts";

async function freshTree(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-m92-rchk-"));
  await mkdir(path.join(root, "sub"), { recursive: true });
  await writeFile(path.join(root, "a.txt"), "alpha\n");
  await writeFile(path.join(root, "b.txt"), "bravo\n");
  await writeFile(path.join(root, "sub", "c.txt"), "charlie\n");
  return root;
}

test("writeIntegrityManifest writes a sorted manifest and excludes itself + .package.lock", async () => {
  const root = await freshTree();
  try {
    // A `.package.lock` flock file must be excluded — the release tooling
    // creates one and would otherwise pollute the manifest.
    await writeFile(path.join(root, ".package.lock"), "lock");
    const manifestPath = await writeIntegrityManifest(root);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(manifestPath, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3, "exactly 3 entries (a.txt, b.txt, sub/c.txt)");
    // Sorted by relative path.
    const paths = lines.map((l) => l.split("  ")[1]);
    assert.deepEqual(paths, ["a.txt", "b.txt", "sub/c.txt"]);
    // Excluded entries must not appear.
    assert.ok(!text.includes(".package.lock"), "manifest excludes .package.lock");
    assert.ok(!text.includes("MANIFEST.sha256"), "manifest excludes itself");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verifyIntegrityManifest accepts a freshly-written manifest", async () => {
  const root = await freshTree();
  try {
    await writeIntegrityManifest(root);
    const result = await verifyIntegrityManifest(root);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.fileCount, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verifyIntegrityManifest returns DIGEST_MISMATCH after a one-byte tamper", async () => {
  const root = await freshTree();
  try {
    await writeIntegrityManifest(root);
    await writeFile(path.join(root, "b.txt"), "BRAVO\n");
    const result = await verifyIntegrityManifest(root);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "DIGEST_MISMATCH");
      assert.ok(result.detail.includes("b.txt"));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verifyIntegrityManifest returns ENTRY_MISSING after a file is removed", async () => {
  const root = await freshTree();
  try {
    await writeIntegrityManifest(root);
    await rm(path.join(root, "sub", "c.txt"));
    const result = await verifyIntegrityManifest(root);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "ENTRY_MISSING");
      assert.equal(result.detail, "sub/c.txt");
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("writeIntegrityManifest is idempotent — re-running produces the same payload", async () => {
  const root = await freshTree();
  try {
    const first = await writeIntegrityManifest(root);
    const { readFile } = await import("node:fs/promises");
    const firstText = await readFile(first, "utf8");
    // Re-running would normally collide on the `wx` flag; the second
    // call must therefore be preceded by deleting the manifest. That
    // mirrors the operational path: a repack deletes the prior
    // manifest as part of `assemble`.
    await rm(first);
    const second = await writeIntegrityManifest(root);
    const secondText = await readFile(second, "utf8");
    assert.equal(secondText, firstText);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("verifyIntegrityManifest returns MANIFEST_MISSING when the manifest is absent", async () => {
  const root = await freshTree();
  try {
    const result = await verifyIntegrityManifest(root);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "MANIFEST_MISSING");
  } finally { await rm(root, { recursive: true, force: true }); }
});
