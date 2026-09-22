import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, symlink, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createPrivateLockFile, privateConfig, privateDirectory, profilePaths } from "../src/main/profile-runtime";

test("profile runtime preserves legacy socket identity and refuses shared or linked paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = profilePaths(root), second = profilePaths(`${root}/other`);
  assert.notEqual(first.runtime, second.runtime);
  assert.equal(first.socket, `${first.parent}/${first.key}.sock`);
  assert.equal(first.lock, `${first.parent}/${first.key}.lock`);
  await privateDirectory(`${root}/private`);
  await chmod(`${root}/private`, 0o755);
  await assert.rejects(privateDirectory(`${root}/private`), /permissions/);
  await privateConfig(`${root}/config`, "original");
  await symlink(`${root}/config`, `${root}/link`);
  await assert.rejects(privateConfig(`${root}/link`, "bad"));
  await chmod(`${root}/config`, 0o644);
  await assert.rejects(privateConfig(`${root}/config`, "bad"), /permissions/);
  assert.equal(await readFile(`${root}/config`, "utf8"), "original");
});

test("createPrivateLockFile prepares a 0600 inode that the runtime helper accepts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-lockfile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lock = path.join(root, "owner.lock");
  await createPrivateLockFile(lock);
  const info = await stat(lock);
  assert.equal(info.isFile(), true);
  assert.equal(info.nlink, 1);
  assert.equal(info.uid, process.getuid!());
  assert.equal(info.mode & 0o777, 0o600);
  // Recreating an existing safe lock must not throw: the helper's flock resolves the rest.
  await createPrivateLockFile(lock);
});

test("createPrivateLockFile rejects a symlink and shared permissions", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-lockfile-bad-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, "real"), link = path.join(root, "link");
  await writeFile(target, "");
  await chmod(target, 0o644);
  await assert.rejects(createPrivateLockFile(target), /permissions/);
  await chmod(target, 0o600);
  await createPrivateLockFile(target);
  await symlink(target, link);
  // O_NOFOLLOW may surface as ELOOP rather than a permissions message; assert on either.
  await assert.rejects(createPrivateLockFile(link), /ELOOP|permissions|symbolic/);
  await chmod(target, 0o666);
  await assert.rejects(createPrivateLockFile(target), /permissions/);
});
