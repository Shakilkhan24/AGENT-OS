import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { publishRelease, rollbackRelease, type ReleaseOptions } from "../../scripts/release.mts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options: ReleaseOptions = {
    root, arch: "x64", version: "1.2.1",
    assemble: directory => writeFile(path.join(directory, "minimal"), "first"),
    smoke: async executable => { assert.equal(await readFile(executable, "utf8"), "first"); },
  };
  return options;
}

test("publication smokes the staged bytes, preserves the old build and excludes stale assets", async t => {
  const options = await fixture(t);
  const current = await publishRelease(options);
  const old = await readlink(path.dirname(current));
  await writeFile(path.join(options.root, old, "stale.txt"), "left by a previous version");
  const next = await publishRelease({ ...options, version: "1.2.2",
    assemble: directory => writeFile(path.join(directory, "minimal"), "second"),
    smoke: async executable => {
      assert.match(executable, /\.staging-/);
      assert.equal(await readFile(current, "utf8"), "first");
      assert.equal(await readFile(executable, "utf8"), "second");
    },
  });
  assert.equal(next, current);
  assert.equal(await readFile(next, "utf8"), "second");
  assert.equal(await readlink(path.join(options.root, "previous-linux-x64")), old);
  assert.equal((await readdir(path.dirname(next))).includes("stale.txt"), false);
  assert.equal(await readFile(await rollbackRelease(options.root, "x64"), "utf8"), "first");
});

test("failed smoke and every publication interruption leave a complete old or new release", async t => {
  const options = await fixture(t);
  const current = await publishRelease(options);
  await assert.rejects(publishRelease({ ...options, smoke: async () => { throw new Error("failed smoke"); } }), /failed smoke/);
  assert.equal(await readFile(current, "utf8"), "first");
  for (const phase of ["staged", "verified", "retained", "previous-updated", "published"] as const) {
    await assert.rejects(publishRelease({ ...options,
      assemble: directory => writeFile(path.join(directory, "minimal"), phase),
      smoke: async executable => assert.equal(await readFile(executable, "utf8"), phase),
      checkpoint: async observed => { if (observed === phase) throw new Error(`interrupted ${phase}`); },
    }), /interrupted/);
    assert.equal(await readFile(current, "utf8"), phase === "published" ? phase : "first");
    assert.equal((await readdir(path.join(options.root, "builds"))).some(name => name.startsWith(".staging-")), false);
  }
});

test("SIGKILL at publication boundaries leaves a usable pointer and permits the next build", async t => {
  for (const phase of ["staged", "verified", "retained", "previous-updated", "published"]) {
    const options = await fixture(t);
    const current = await publishRelease(options);
    const child = spawn(process.execPath, ["--import", "tsx", "tests/fixtures/release-child.mts", options.root, phase], { stdio: "ignore" });
    const result = await new Promise<{code: number | null; signal: string | null}>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.signal, "SIGKILL");
    assert.equal(await readFile(current, "utf8"), phase === "published" ? "second" : "first");
    await publishRelease(options);
    assert.equal(await readFile(current, "utf8"), "first");
  }
});

test("publication refuses invalid versions and unexpected current entries before assembly", async t => {
  const options = await fixture(t);
  for (const version of ["01.2.3", "1.2", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+", "../1.2.3", "1.2.3\n"]) {
    await assert.rejects(publishRelease({ ...options, version }), /semantic version/);
  }
  await writeFile(path.join(options.root, "current-linux-x64"), "user-owned entry");
  await assert.rejects(publishRelease({ ...options, assemble: async () => assert.fail("must not assemble") }));
  assert.equal(await readFile(path.join(options.root, "current-linux-x64"), "utf8"), "user-owned entry");
});
