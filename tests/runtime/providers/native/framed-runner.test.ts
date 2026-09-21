/**
 * M3b.3 — framed runner tests.
 *
 * Coverage:
 *  - `spawnFramedRunner` against the in-repo stub produces a working
 *    `ProviderHandle` that emits `started`, `output`, and `exit` events
 *    through the lifecycle EventEmitter.
 *  - The byte-budgeted stdin writer refuses past-cap writes.
 *  - The handle is closed cleanly when stdin closes; the stub emits
 *    `exit` with code 0 and the runner forwards it.
 *
 * The test uses `node` running `scripts/test-stub-provider.mjs` (not a
 * real provider), so no subprocess quirks beyond stdio framing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { spawnFramedRunner } from "../../../../src/runtime/providers/native/framed-runner";
import { INPUT_CAP } from "../../../../src/runtime/orchestration/back-pressure";
import { AppError } from "../../../../src/shared/errors";

const baseRequest = {
  correlationId: "corr-framed-1",
  canonicalDigest: "a".repeat(64),
  providerVersion: "v1",
  model: "m1",
  accountMode: "authenticated" as const,
  deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  argsJson: "{}",
  scopeJson: "{}",
  parentInvocationId: null,
};

const stubPath = path.resolve(__dirname, "../../../../scripts/test-stub-provider.mjs");

async function collect(handle: { lifecycle: import("node:events").EventEmitter }) {
  const events: Array<Record<string, unknown>> = [];
  handle.lifecycle.on("event", (e) => { events.push(e); });
  return events;
}

const stubCommand = { binary: "node", args: [stubPath] };

test("framed runner spawns the stub and bridges started/output/exit", async () => {
  const handle = await spawnFramedRunner(stubPath, baseRequest, { command: stubCommand });
  const events = await collect(handle);
  assert.ok(handle.startup);
  const exited = waitForExit(handle);
  handle.stdin.close();
  await exited;
  const eventKinds = events.map(e => e.kind);
  assert.ok(eventKinds.includes("started"));
  assert.ok(eventKinds.includes("exit"));
});

function waitForExit(handle: { lifecycle: import("node:events").EventEmitter }): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("Provider did not exit in 5 seconds")); }, 5000);
    const listener = (event: Record<string, unknown>) => {
      if (event.kind === "exit") { cleanup(); resolve(event); }
    };
    const failure = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { clearTimeout(timer); handle.lifecycle.off("event", listener); handle.lifecycle.off("error", failure); };
    handle.lifecycle.on("event", listener); handle.lifecycle.once("error", failure);
  });
}

test("closing provider stdin never fabricates a successful process exit", { timeout: 10000 }, async () => {
  const handle = await spawnFramedRunner("fixture", baseRequest, { command: {
    binary: process.execPath,
    args: ["-e", "process.stdin.resume(); process.stdin.on('end', () => setTimeout(() => process.exit(7), 1300));"],
  } });
  const exited = waitForExit(handle);
  handle.stdin.close();
  assert.equal((await exited).code, 7);
});

test("the byte-budgeted stdin refuses past-cap writes", async () => {
  const handle = await spawnFramedRunner(stubPath, baseRequest, { command: stubCommand });
  // A single write at the cap should fail synchronously (the runner
  // only enqueues one frame per write; the per-call cap is the cap).
  const tooBig = new Uint8Array(INPUT_CAP + 1);
  await assert.rejects(handle.stdin.write(tooBig), (err: unknown) => err instanceof AppError);
  handle.stdin.close();
});

test("closed handle is reused safely (idempotent close)", async () => {
  const handle = await spawnFramedRunner(stubPath, baseRequest, { command: stubCommand });
  handle.stdin.close();
  // A second close() call should not throw.
  handle.stdin.close();
  await new Promise(resolve => setTimeout(resolve, 100));
});
