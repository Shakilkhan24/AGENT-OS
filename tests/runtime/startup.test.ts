import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, open, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { prepareRuntimeStartup } from "../../src/runtime/startup";
import { isolatedRuntimePaths } from "../support";

test("a direct runtime entry cannot remove discovery files without a held OS lock", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "minimal-startup-"));
  const paths = isolatedRuntimePaths(dir, dir);
  const ready = path.join(paths.runtime, "ready.json");
  const original = process.env.MINIMAL_LOCK_FD;
  try {
    delete process.env.MINIMAL_LOCK_FD;
    await assert.rejects(prepareRuntimeStartup(dir, paths.runtime, paths.socket), /lock helper/);
    await writeFile(ready, "existing owner discovery");
    // An open descriptor is insufficient: it must carry this process's flock.
    const handle = await open(paths.lock, "wx", 0o600);
    try {
      process.env.MINIMAL_LOCK_FD = String(handle.fd);
      await assert.rejects(prepareRuntimeStartup(dir, paths.runtime, paths.socket), /exclusive profile lock/);
      assert.equal(await readFile(ready, "utf8"), "existing owner discovery");
    } finally { await handle.close(); }
  } finally {
    if (original === undefined) delete process.env.MINIMAL_LOCK_FD;
    else process.env.MINIMAL_LOCK_FD = original;
    await rm(dir, { recursive: true, force: true });
  }
});
