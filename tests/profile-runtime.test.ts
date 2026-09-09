import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, chmod, symlink, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { privateConfig, privateDirectory, profilePaths } from "../src/main/profile-runtime";

test("profile runtime preserves legacy socket identity and refuses shared or linked paths", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = profilePaths(root), second = profilePaths(`${root}/other`);
  assert.notEqual(first.runtime, second.runtime);
  assert.equal(first.socket, `${first.parent}/${first.key}.sock`);
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
