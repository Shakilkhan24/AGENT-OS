import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { serviceFixture } from "./support";
import { SessionFilesystem } from "../src/main/filesystem";
import { defaultSettings } from "../src/shared/settings";
import { AppError } from "../src/shared/errors";

test("save conflicts preserve both edits and require a fresh reviewed hash", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  await writeFile(path.join(f.root, "file"), "opened");
  const opened = await f.service.files(f.session.id, { action: "preview", path: "file" });
  await writeFile(path.join(f.root, "file"), "external");
  const conflict = await f.service.files(f.session.id, { action: "write", path: "file", expectedHash: opened.hash!, content: "my edits" });
  assert.equal(conflict.saved, false);
  assert.equal(await readFile(path.join(f.root, "file"), "utf8"), "external");
  assert.ok(!conflict.saved);
  assert.equal(conflict.current.content, "external");
  const saved = await f.service.files(f.session.id, { action: "write", path: "file", expectedHash: conflict.current.hash!, content: "my edits" });
  assert.equal(saved.saved, true);
  assert.equal(await readFile(path.join(f.root, "file"), "utf8"), "my edits");
});

test("directory cursors page incrementally and cannot be reused for another path", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  await Promise.all(Array.from({ length: 530 }, (_, index) => writeFile(path.join(f.root, `entry-${index}`), "")));
  let page = await f.service.files(f.session.id, { action: "list-page", path: "", limit: 200 });
  assert.equal(page.entries.length, 200);
  assert.ok(page.cursor);
  await assert.rejects(f.service.files(f.session.id, { action: "list-page", path: "another", cursor: page.cursor }), /cursor/);
  const names = new Set(page.entries.map(entry => entry.name));
  while (page.cursor) {
    page = await f.service.files(f.session.id, { action: "list-page", path: "", cursor: page.cursor });
    page.entries.forEach(entry => names.add(entry.name));
  }
  assert.equal(names.size, 530);
});

test("timed out workers are replaced and cancellation never automatically retries an operation", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const helper = path.join(f.base, "slow.py"), marker = path.join(f.base, "attempted");
  await writeFile(helper, `import sys, json, time, pathlib, runpy\nsys.path.insert(0, ${JSON.stringify(path.resolve("helpers"))})\noriginal = sys.stdin\ndef requests():\n    for line in original:\n        req = json.loads(line)\n        marker = pathlib.Path(${JSON.stringify(marker)})\n        if req['action'] == 'list' and not marker.exists():\n            marker.touch()\n            time.sleep(10)\n        yield line\nsys.stdin = requests()\nrunpy.run_path(${JSON.stringify(path.resolve("helpers/filesystem.py"))}, run_name='__main__')\n`);
  // A busy CI runner can take a few hundred ms to import runpy + filesystem.py
  // before the worker reaches its `time.sleep(10)`. The timeout has to be
  // comfortably above that startup cost or the worker gets killed before it
  // ever blocks, and the helper's reconnect replaces it instead of timing
  // out. 2 s is well above the worst observed wall-clock on a loaded runner
  // and still well below the sleep so the test keeps its semantics.
  const files = new SessionFilesystem(helper, { ...defaultSettings, fileTimeoutMs: 2000 }); t.after(async () => { await files.close(); });
  await assert.rejects(files.run(f.session, { action: "list", path: "" }), (error: unknown) => error instanceof AppError && error.failure.code === "TIMEOUT");
  assert.deepEqual(await files.run(f.session, { action: "list", path: "" }), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(files.run(f.session, { action: "create", path: "never", kind: "file" }, { signal: controller.signal }), (error: unknown) => error instanceof AppError && error.failure.code === "CANCELLED" && !error.failure.outcomeUnknown);
  assert.deepEqual(await files.run(f.session, { action: "list", path: "" }), []);
});

test("invalid Python result shapes fail visibly before reaching a caller", async (t) => {
  const f = await serviceFixture(); t.after(f.cleanup);
  const helper = path.join(f.base, "invalid.py");
  await writeFile(helper, "import json, sys\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps(dict(apiVersion=2,id=r['id'],correlationId=r['correlationId'],ok=True,result={'wrong':True})),flush=True)\n");
  const files = new SessionFilesystem(helper); t.after(async () => { await files.close(); });
  await assert.rejects(files.register(f.session.id, f.root), /invalid payload/);
});
