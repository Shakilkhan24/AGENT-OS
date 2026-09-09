import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicJson } from "../src/main/atomic";
test("atomic documents preserve the previous value on serialization failure and clean temporary files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-atomic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "value.json");
  await atomicJson(file, { valid: true });
  await assert.rejects(atomicJson(file, { invalid: 1n }));
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { valid: true });
  assert.deepEqual(await readdir(root), ["value.json"]);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
