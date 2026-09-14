/**
 * Focused tests for M2.2 — stable profile identity and storage separation.
 *
 * These tests prove:
 *  - a fresh profile mints a new random identity and persists it;
 *  - moving the data directory preserves the identity (file moves with it);
 *  - the control-state DB lives on Linux-native storage, separate from the
 *    user's data directory;
 *  - directory ownership/mode mismatches are refused, not silently fixed;
 *  - the legacy key derivation remains available for one-shot migration.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isLinuxNativePath,
  legacyProfileKey,
  mintProfileIdentity,
  prepareProfileStorage,
  resolveProfilePaths,
} from "../../src/runtime/db/profile";

test("resolveProfilePaths mints a new identity when none exists", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = await resolveProfilePaths(dataDir);
  assert.match(paths.profileId, /^[a-f0-9]{32}$/);
  assert.notEqual(paths.database, path.join(dataDir, "state.db"));
  assert.ok(paths.database.startsWith("/tmp/minimal-"));
  assert.equal(paths.dataDir, dataDir);
});

test("resolveProfilePaths preserves the identity after moving the data dir", async t => {
  const original = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  const moved = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  t.after(async () => {
    await rm(original, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  });
  const first = await resolveProfilePaths(original);
  await rename(original, path.join(moved, "data"));
  const second = await resolveProfilePaths(path.join(moved, "data"));
  assert.equal(second.profileId, first.profileId, "identity must survive data-dir relocation");
  assert.equal(second.controlDir, first.controlDir);
});

test("prepareProfileStorage refuses unsafe directory ownership or permissions", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = await resolveProfilePaths(dataDir);
  await prepareProfileStorage(paths);
  // World-readable storage dir must be rejected on the next call.
  await chmod(paths.controlDir, 0o755);
  t.after(() => chmod(paths.controlDir, 0o700).catch(() => {}));
  await assert.rejects(prepareProfileStorage(paths), /unsafe/);
});

test("mintProfileIdentity refuses to overwrite an existing identity", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const id = await mintProfileIdentity(dataDir);
  // A second mint must not silently rewrite the file: it should throw so
  // the caller can detect the conflict and refuse the operation.
  await assert.rejects(mintProfileIdentity(dataDir));
  assert.equal(id, (await resolveProfilePaths(dataDir)).profileId);
});

test("legacyProfileKey is deterministic across runs", () => {
  const dataDir = "/tmp/legacy-test";
  const key = legacyProfileKey(dataDir);
  assert.equal(key, legacyProfileKey(dataDir));
  assert.match(key, /^[a-f0-9]{20}$/);
});

test("isLinuxNativePath recognises /tmp, /var and /home but not /mnt", () => {
  assert.equal(isLinuxNativePath("/tmp/foo"), true);
  assert.equal(isLinuxNativePath("/var/lib/minimal"), true);
  assert.equal(isLinuxNativePath("/home/user/data"), true);
  assert.equal(isLinuxNativePath("/mnt/c/Users/foo"), false);
  assert.equal(isLinuxNativePath("/mnt/wsl/instance/data"), false);
});

test("the control-state DB lives on Linux-native storage, separate from the data dir", async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "minimal-profile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const paths = await resolveProfilePaths(dataDir);
  // The DB must not be inside the user's data directory; it must be staged.
  assert.ok(!paths.database.startsWith(paths.dataDir), "DB must not be under the user's data directory");
  assert.ok(isLinuxNativePath(path.dirname(paths.database)), "DB directory must be on Linux-native storage");
  await prepareProfileStorage(paths);
  const info = await stat(paths.controlDir);
  assert.equal(info.isDirectory(), true);
});
