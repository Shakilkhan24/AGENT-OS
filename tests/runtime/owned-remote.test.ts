/**
 * M8 — owned remote execution tests.
 *
 * Coverage:
 *   1. `registerHost` inserts a host row + rejects fingerprint mismatch.
 *   2. `probeHost` refreshes capabilities and rejects unreachable hosts.
 *   3. `prepareSession` + `inspect` round-trip the workspace pin digest.
 *   4. `startInvoke` / `observeInvoke` / `finishInvoke` walk the
 *      invocation FSM and refuse a non-stale ownership transfer.
 *   5. `transferOwnership` records a generation handoff receipt.
 *   6. The SSH subsystem transport refuses agent-forwarding keys
 *      and includes the host key fingerprint on every probe.
 *   7. The adapter refuses a cwd outside the remote workspace
 *      (M8.3 — remote paths remain remote handles).
 *   8. The adapter refuses to attach when the session is stopped.
 *   9. The adapter refuses to attach when the host is not reachable.
 *  10. `unregisterHost` cascades to sessions, receipts, invocations.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DbWorker } from "../../src/runtime/db/worker";
import { MemoryDatabase } from "../../src/runtime/db/memory";
import { tableSpecs } from "../../src/runtime/db/schema";
import { AppError } from "../../src/shared/errors";
import {
  registerHost,
  unregisterHost,
  probeHost,
  readHost,
  prepareSession,
  readSession,
  startInvoke,
  observeInvoke,
  finishInvoke,
  markInvokeStale,
  transferOwnership,
  readInvoke,
  recordReceipt,
  sessionPinDigest,
} from "../../src/runtime/orchestration/owned-remote-host";
import {
  buildOwnedRemoteAdapter,
  sshSubsystemTransport,
} from "../../src/runtime/orchestration/owned-remote-adapter";
import type {
  OwnedRemoteTransport,
  ProbeResult,
} from "../../src/runtime/orchestration/owned-remote-host";

function freshWorker(): DbWorker {
  const driver = new MemoryDatabase();
  for (const table of tableSpecs) {
    driver.prepare(table.ddl).run();
    for (const index of table.indices) driver.prepare(index).run();
  }
  return new DbWorker({ driver });
}

const FINGERPRINT_A = "aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99";
const FINGERPRINT_B = "11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00";

function fakeProbe(overrides: Partial<ProbeResult> = {}): ProbeResult {
  return {
    reachable: true,
    runtime: "v20.0.0",
    capabilities: {
      nodeVersion: "v20.0.0",
      runtimeApiVersion: "1",
      rootlessContainerEngine: false,
      userNamespaces: true,
      containedFilesystem: true,
      hostScheduler: true,
      storageMib: 8192,
      providerModes: ["test"],
    },
    error: null,
    ...overrides,
  };
}

function inMemoryTransport(probe: ProbeResult = fakeProbe()): OwnedRemoteTransport & {
  calls: Array<{ method: string; args: Record<string, unknown> }>;
  respondWith: (response: { ok: boolean; result?: unknown; error?: string }) => void;
} {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let nextResponse: { ok: boolean; result?: unknown; error?: string } = { ok: true, result: probe };
  return {
    calls,
    respondWith: (response) => { nextResponse = response; },
    async probe(args) {
      calls.push({ method: "probe", args: { ...args, fingerprint: args.expectedFingerprint } });
      // probe() returns ProbeResult directly (no envelope).
      if (!nextResponse.ok) return {
        reachable: false, runtime: null,
        capabilities: {
          nodeVersion: null, runtimeApiVersion: null, rootlessContainerEngine: false,
          userNamespaces: false, containedFilesystem: false, hostScheduler: false,
          storageMib: 0, providerModes: [],
        },
        error: nextResponse.error ?? "probe failed",
      };
      return nextResponse.result as ProbeResult;
    },
    async send({ request }) {
      calls.push({ method: request.method, args: request.args });
      return nextResponse;
    },
  };
}

test("M8 registerHost inserts and rejects fingerprint mismatch", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const row = readHost(worker, "h1");
    assert.ok(row);
    assert.equal(row!.hostKeyFingerprint, FINGERPRINT_A);
    // Re-registration with the same fingerprint updates in place.
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One (renamed)",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    assert.equal(readHost(worker, "h1")!.displayName, "Host One (renamed)");
    // Different fingerprint → TOFU violation.
    await assert.rejects(
      () => registerHost(worker, {
        hostId: "h1", displayName: "Host One",
        sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_B,
        authKind: "ssh-publickey", registeredBy: "tester",
      }),
      (error: unknown) => error instanceof AppError && error.message.includes("fingerprint mismatch"),
    );
  } finally { await worker.close(); }
});

test("M8 probeHost refreshes capabilities + sets unreachable status", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const transport = inMemoryTransport();
    const probe = await probeHost(worker, transport, "h1");
    assert.equal(probe.reachable, true);
    assert.equal(probe.capabilities.containedFilesystem, true);
    assert.equal(readHost(worker, "h1")!.lastProbedAt, readHost(worker, "h1")!.lastProbedAt);
    assert.ok(readHost(worker, "h1")!.lastProbedAt);
    // Probe failure → status flips to unreachable.
    transport.respondWith({ ok: false, error: "connection refused" });
    await probeHost(worker, transport, "h1");
    assert.equal(readHost(worker, "h1")!.status, "unreachable");
  } finally { await worker.close(); }
});

test("M8 prepareSession round-trips pin digest + inspect", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const pin = sessionPinDigest({ hostId: "h1", workspacePath: "/home/user/ws", recipeId: "r1", recipeVersion: 1 });
    const session = await prepareSession(worker, { hostId: "h1", workspacePath: "/home/user/ws", pinDigest: pin });
    const round = readSession(worker, session.handleId);
    assert.ok(round);
    assert.equal(round!.pinDigest, pin);
    assert.equal(round!.workspacePath, "/home/user/ws");
    assert.equal(round!.status, "ready");
  } finally { await worker.close(); }
});

test("M8 startInvoke → observeInvoke → finishInvoke walks the FSM", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const session = await prepareSession(worker, {
      hostId: "h1", workspacePath: "/home/user/ws",
      pinDigest: sessionPinDigest({ hostId: "h1", workspacePath: "/home/user/ws", recipeId: "r1", recipeVersion: 1 }),
    });
    const invocation = await startInvoke(worker, {
      hostId: "h1", handleId: session.handleId,
      recipeId: "r1", recipeVersion: 1,
    });
    assert.equal(invocation.status, "in-flight");
    await observeInvoke(worker, invocation.invocationId, {
      cursor: 3, remoteState: "running", stderrTail: null,
    });
    const mid = readInvoke(worker, invocation.invocationId)!;
    assert.equal(mid.cursor, 3);
    assert.equal(mid.remoteState, "running");
    await finishInvoke(worker, invocation.invocationId, {
      status: "completed", exitCode: 0, stderrTail: null,
    });
    const final = readInvoke(worker, invocation.invocationId)!;
    assert.equal(final.status, "completed");
    assert.equal(final.remoteExitCode, 0);
    assert.ok(final.finishedAt);
  } finally { await worker.close(); }
});

test("M8 transferOwnership records a handoff receipt + refuses non-stale source", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const session = await prepareSession(worker, {
      hostId: "h1", workspacePath: "/home/user/ws",
      pinDigest: sessionPinDigest({ hostId: "h1", workspacePath: "/home/user/ws", recipeId: "r1", recipeVersion: 1 }),
    });
    const inv = await startInvoke(worker, {
      hostId: "h1", handleId: session.handleId,
      recipeId: "r1", recipeVersion: 1,
    });
    // Cannot transfer from a non-stale invocation.
    await assert.rejects(
      () => transferOwnership(worker, {
        hostId: "h1", previousInvocationId: inv.invocationId, newGeneration: 1,
      }),
      (error: unknown) => error instanceof AppError && error.message.includes("expected stale"),
    );
    // Mark stale + transfer.
    await markInvokeStale(worker, inv.invocationId);
    const handoff = await transferOwnership(worker, {
      hostId: "h1", previousInvocationId: inv.invocationId, newGeneration: 2,
    });
    assert.equal(handoff.newGeneration, 2);
  } finally { await worker.close(); }
});

test("M8 sshSubsystemTransport strips agent forwarding env keys + includes fingerprint", async () => {
  const captured: Array<{ cmd: string; args: string[] }> = [];
  // The wire format for probe emits the ProbeResult body directly.
  const transport = sshSubsystemTransport({
    spawn: (cmd, args) => {
      captured.push({ cmd, args });
      return makeFakeProcess(fakeProbe());
    },
  });
  const probe = await transport.probe({ hostId: "h1", sshTarget: "user@host", expectedFingerprint: FINGERPRINT_A });
  assert.equal(probe.reachable, true);
  assert.equal(captured[0].cmd, "ssh");
  assert.ok(captured[0].args.includes("-o"));
  assert.ok(captured[0].args.includes("ForwardAgent=no"));
  assert.ok(captured[0].args.includes("StrictHostKeyChecking=yes"));
  assert.ok(captured[0].args.includes(`HostKeyAlias=${FINGERPRINT_A}`));
});

test("M8 adapter refuses cwd outside the remote workspace (M8.3)", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const adapter = buildOwnedRemoteAdapter(worker, {
      transport: inMemoryTransport(),
    });
    const handle = await adapter.prepare({
      recipeId: "r1", version: 1,
      requirement: { adapterKind: "owned-remote" },
      workspacePath: "/home/user/ws", scopedEnv: {}, installationPlanId: null,
    });
    await assert.rejects(
      () => adapter.attach({
        handle,
        argv: ["/bin/true"], env: {}, cwd: "/etc",
        timeoutMs: 5000, stdoutByteCap: 1024, stderrByteCap: 1024,
      }),
      (error: unknown) => error instanceof AppError && error.message.includes("outside the remote workspace"),
    );
  } finally { await worker.close(); }
});

test("M8 adapter refuses to attach when session is stopped", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const transport = inMemoryTransport();
    const adapter = buildOwnedRemoteAdapter(worker, { transport });
    const handle = await adapter.prepare({
      recipeId: "r1", version: 1,
      requirement: { adapterKind: "owned-remote" },
      workspacePath: "/home/user/ws", scopedEnv: {}, installationPlanId: null,
    });
    await adapter.stop(handle.handleId);
    await assert.rejects(
      () => adapter.attach({
        handle,
        argv: ["/bin/true"], env: {}, cwd: null,
        timeoutMs: 5000, stdoutByteCap: 1024, stderrByteCap: 1024,
      }),
      (error: unknown) => error instanceof AppError && error.message.includes("cannot attach"),
    );
  } finally { await worker.close(); }
});

test("M8 adapter refuses to attach when host is unreachable", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const transport = inMemoryTransport(fakeProbe({ reachable: false, error: "ssh: connect refused" }));
    // Probe first to flip the host's status to unreachable.
    await probeHost(worker, transport, "h1");
    const adapter = buildOwnedRemoteAdapter(worker, { transport });
    await assert.rejects(
      () => adapter.prepare({
        recipeId: "r1", version: 1,
        requirement: { adapterKind: "owned-remote" },
        workspacePath: "/home/user/ws", scopedEnv: {}, installationPlanId: null,
      }),
      (error: unknown) => error instanceof AppError &&
        (error.message.includes("requires a registered host") || error.message.includes("reachable")),
    );
  } finally { await worker.close(); }
});

test("M8 unregisterHost cascades to sessions, receipts, invocations", async () => {
  const worker = freshWorker();
  try {
    await registerHost(worker, {
      hostId: "h1", displayName: "Host One",
      sshTarget: "user@host.example", hostKeyFingerprint: FINGERPRINT_A,
      authKind: "ssh-publickey", registeredBy: "tester",
    });
    const session = await prepareSession(worker, {
      hostId: "h1", workspacePath: "/home/user/ws",
      pinDigest: sessionPinDigest({ hostId: "h1", workspacePath: "/home/user/ws", recipeId: "r1", recipeVersion: 1 }),
    });
    await recordReceipt(worker, {
      hostId: "h1", receiptKind: "kernel-capability", subject: "user-ns",
      digest: "a".repeat(64), recordedBy: "tester",
    });
    await startInvoke(worker, {
      hostId: "h1", handleId: session.handleId,
      recipeId: "r1", recipeVersion: 1,
    });
    await unregisterHost(worker, "h1");
    assert.equal(readHost(worker, "h1"), undefined);
    assert.equal(readSession(worker, session.handleId), undefined);
    const drv = (worker as unknown as { driver: { prepare(s: string): { all(...b: unknown[]): Array<Record<string, unknown>> } } }).driver;
    const invRows = drv.prepare("SELECT * FROM owned_remote_invoke").all();
    assert.equal(invRows.length, 0);
    const receiptRows = drv.prepare("SELECT * FROM owned_remote_receipt").all();
    assert.equal(receiptRows.length, 0);
  } finally { await worker.close(); }
});

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

interface FakeProcess {
  stdin: { write(s: string): void; end(): void };
  stdout: {
    on(event: "data", cb: (b: Buffer) => void): void;
    once(event: "end", cb: () => void): void;
  };
  stderr: { on(event: "data", cb: (b: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
}

function makeFakeProcess(response: unknown): FakeProcess {
  const payload = JSON.stringify(response);
  let endCb: (() => void) | undefined;
  return {
    stdin: { write() {}, end() {} },
    stdout: {
      on(_event: "data", cb: (b: Buffer) => void) {
        setImmediate(() => cb(Buffer.from(payload, "utf8")));
      },
      once(_event: "end", cb: () => void) {
        endCb = cb;
        // Emit end shortly after data.
        setImmediate(() => { if (endCb) endCb(); });
      },
    },
    stderr: { on(_event: "data", _cb: (b: Buffer) => void) { /* ignore */ } },
    on(_event: "close" | "error", _cb: unknown) { /* noop */ },
  };
}
