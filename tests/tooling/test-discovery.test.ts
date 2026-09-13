import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { discoverTests } from "../../scripts/test.mts";

test("backend discovery includes nested tests and excludes fixtures, desktop cases and symlinks", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "deep/nested"), { recursive: true });
  for (const file of ["z.test.ts", "deep/nested/a.test.ts", "deep/desktop.spec.ts", "deep/helper.ts"]) {
    await writeFile(path.join(root, file), "");
  }
  await symlink(root, path.join(root, "deep/loop"));
  await symlink(path.join(root, "z.test.ts"), path.join(root, "linked.test.ts"));
  assert.deepEqual(await discoverTests(root), [path.join(root, "deep/nested/a.test.ts"), path.join(root, "z.test.ts")]);
});
