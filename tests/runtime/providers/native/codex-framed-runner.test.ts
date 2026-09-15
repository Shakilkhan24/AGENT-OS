/**
 * M4.1 — Codex framed runner metadata forwarding test.
 *
 * The framed runner (`runtime/providers/native/framed-runner.ts`)
 * spawns the adapter as a child process and wraps its stdout in a
 * `FrameDecoder`. M4.1 extends the runner to forward the adapter's
 * `started.metadata` field into `handle.startup.metadata` so the
 * codex adapter's asymmetry (`bidirectionalInput: false`,
 * `scheme: "codex"`) is observable to the orchestrator.
 *
 * This test drives the runner with the hermetic codex stub
 * (`scripts/test-stub-provider-codex.mjs`) and asserts:
 *  - `startup.kind` is `"native-framed"` (the existing discriminator),
 *  - `startup.metadata` carries the codex-specific fields the stub
 *    emitted in its `started` frame,
 *  - the existing Claude path (which does not emit `metadata`) is
 *    unaffected — `startup.metadata` stays absent.
 *
 * The stub is the test's hermetic subprocess, so the test does not
 * need a real Codex binary on PATH.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnFramedRunner } from "../../../../src/runtime/providers/native/framed-runner";
import type { SpawnRequest, ProviderHandle } from "../../../../src/runtime/providers/adapter";
import { AppError } from "../../../../src/shared/errors";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const codexStub = path.join(repoRoot, "scripts", "test-stub-provider-codex.mjs");
const claudeStub = path.join(repoRoot, "scripts", "test-stub-provider.mjs");

function newRequest(providerVersion: string): SpawnRequest {
  return {
    correlationId: `corr-${providerVersion}-${Date.now()}`,
    canonicalDigest: "d".repeat(64),
    providerVersion,
    model: providerVersion,
    accountMode: "authenticated",
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    argsJson: "{}",
    scopeJson: "{}",
    parentInvocationId: null,
  };
}

async function waitForStarted(handle: ProviderHandle, timeoutMs = 2_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for started")), timeoutMs);
    handle.lifecycle.on("event", (event) => {
      if (event.kind === "started") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

test("codex stub surfaces metadata.scheme + bidirectionalInput in handle.startup", async () => {
  const handle = await spawnFramedRunner(
    codexStub,
    newRequest("codex-0.0.1"),
    { command: { binary: process.execPath, args: [codexStub] } },
  );
  await waitForStarted(handle);
  assert.ok(handle.startup, "codex runner should produce a startup envelope");
  assert.equal(handle.startup?.kind, "native-framed");
  const metadata = handle.startup?.metadata as { scheme?: string; bidirectionalInput?: boolean } | undefined;
  assert.ok(metadata, "codex stub should populate startup.metadata");
  assert.equal(metadata?.scheme, "codex");
  assert.equal(metadata?.bidirectionalInput, false);
  // Tidy shutdown so the runner's deferred-exit timer does not leak.
  handle.stdin.close();
  await handle.exit("test-done");
});

test("claude stub does NOT populate startup.metadata (existing path unchanged)", async () => {
  const handle = await spawnFramedRunner(
    claudeStub,
    newRequest("claude-0.0.1"),
    { command: { binary: process.execPath, args: [claudeStub] } },
  );
  await waitForStarted(handle);
  assert.ok(handle.startup, "claude runner should produce a startup envelope");
  assert.equal(handle.startup?.kind, "native-framed");
  assert.equal(handle.startup?.metadata, undefined);
  handle.stdin.close();
  await handle.exit("test-done");
});

test("M4.5: bad providerProfile envOverride exits the runner with a structured INVALID_REQUEST error", async () => {
  // The runner's translation branch catches the AppError thrown
  // by `translateProviderConfig`, emits it on the lifecycle, and
  // returns a synthetic handle whose `startup.translationError`
  // carries the failure code. We assert that contract here
  // without spawning a real child.
  const handle = await spawnFramedRunner(
    claudeStub,
    newRequest("claude-0.0.1"),
    {
      command: { binary: process.execPath, args: [claudeStub] },
      providerProfile: {
        binaryArgs: [],
        // LD_PRELOAD is the canonical loader-injection vector.
        envOverrides: { LD_PRELOAD: "/tmp/evil.so" },
        workingDirectory: null,
      },
    },
  );
  assert.equal(handle.startup?.kind, "native-framed");
  assert.equal(handle.startup?.translationError, "INVALID_REQUEST");
  const error = await new Promise<AppError>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for error event")), 1_000);
    handle.lifecycle.on("error", (e) => { clearTimeout(timer); resolve(e as AppError); });
  });
  assert.ok(error instanceof AppError);
  assert.equal(error.failure.code, "INVALID_REQUEST");
});
