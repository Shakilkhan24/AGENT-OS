import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { createAttachment } from "../src/main/pty-attachment";
import { utf8Bytes } from "../src/shared/terminal-flow";

test("sustained Unicode output crosses the pause threshold and resumes after acknowledgement", { timeout: 10000 }, async (t) => {
  const root = await mkdtemp('/tmp/minimal-output-');
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "producer.py");
  await writeFile(helper, `import base64,json,time
chunk=json.dumps({'data':base64.b64encode(('λ'*1024).encode()).decode()})
for _ in range(500):
 print(chunk,flush=True)
 time.sleep(0.001)
`);
  let received = 0, pending = 0;
  const attachment = createAttachment(helper, [], 80, 24, (_token, text) => {
    const bytes = utf8Bytes(text); received += bytes; pending += bytes;
  }, () => {});
  const acknowledge = setInterval(() => { attachment.acknowledge(pending); pending = 0; }, 150);
  t.after(() => { clearInterval(acknowledge); attachment.close(); });
  for (let i = 0; i < 150 && received < 1024000; i++) await delay(25);
  assert.equal(received, 1024000);
});
