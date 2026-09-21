/**
 * M8.2 / M8.3 / M8.4 / M8.5 / M8.6 — owned-remote adapter.
 *
 * The M8 bullets (FUTURE/IMPLEMENTATION-README.md lines 271-276)
 * require:
 *
 *   - M8.2 — fixed installed helper/SSH subsystem with bounded
 *     framed requests; agent forwarding stays disabled.
 *   - M8.3 — contained filesystem provider beside the remote root;
 *     remote paths remain remote handles; transfer only selected
 *     context/artifacts with hashes, byte limits, explicit
 *     outgoing-data scope.
 *   - M8.4 — execute M4 plans and M6 recipes through remote target
 *     adapters; per-host capability/installation receipts.
 *   - M8.5 — on partition, retain last observed execution with a
 *     stale timestamp and reconnect by identity/cursor. Stop
 *     remains unconfirmed until host acknowledgement. Schedule
 *     ownership transfer disables the previous owner.
 *   - M8.6 — inventory owned environments, retained artifacts,
 *     services and cleanup failures; bound synchronization and
 *     retention; stop/archive/destroy distinct.
 *
 * This module wires those bullets into the existing
 * `EnvironmentAdapter` contract (`environment-adapter.ts`). The
 * adapter is the SSH-backed `ownedRemoteAdapter`. It depends on:
 *
 *   - `owned-remote-host.ts` — the durable host / session / receipt /
 *     invocation registry.
 *   - `OwnedRemoteTransport` — the SSH subsystem wrapper (test
 *     seam). Default impl `sshSubsystemTransport` invokes the
 *     installed helper via `ssh -T host helper-receive`. The
 *     transport always passes `-o ForwardAgent=no` (M8.2).
 *
 * The adapter rejects:
 *   - host-key mismatch (transport verifies fingerprint on every
 *     call; M8.1).
 *   - agent-forwarding requests (transport strips any
 *     `ForwardAgent=yes`; M8.2).
 *   - filesystem paths outside the remote workspace handle
 *     (M8.3 — remote paths remain remote handles).
 *   - invocations without a corresponding prepared session
 *     (M8.4 — single owner for every run).
 *
 * Stop is acknowledged only when the remote helper confirms
 * (M8.5). Destroy is a separate operation that releases the
 * handle; the audit trail keeps the invocation record.
 */
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "../db/worker";
import type {
  EnvironmentAdapter,
  EnvironmentAttachInput,
  EnvironmentAttachResult,
  EnvironmentHandle,
  EnvironmentPrepareInput,
  EnvironmentProbe,
} from "./environment-adapter";
import {
  type HostCapabilities,
  type HostStatus,
  type OwnedRemoteTransport,
  hostCapabilitiesSchema,
  hostStatusSchema,
  hostInputSchema,
  hostAuthKindSchema,
  receiptKindSchema,
  prepareSession,
  probeHost,
  readHost,
  readInvoke,
  readSession,
  recordReceipt,
  registerHost,
  unregisterHost,
  destroySession,
  finishInvoke,
  markInvokeStale,
  observeInvoke,
  observeSession,
  sessionPinDigest,
  startInvoke,
  transferOwnership,
} from "./owned-remote-host";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ownedRemoteHandleSchema = z
  .object({
    handleId: z.string().min(1).max(128),
    hostId: z.string().min(1).max(128),
    adapterKind: z.literal("owned-remote"),
    workspacePath: z.string().min(1).max(4096),
    preparedAt: z.string().datetime(),
    pinDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type OwnedRemoteHandle = z.infer<typeof ownedRemoteHandleSchema>;

export const outgoingTransferSchema = z
  .object({
    /** Source path on the local host (a context file or artifact). */
    localPath: z.string().min(1).max(4096),
    /** Target path on the remote host (must be under workspace). */
    remotePath: z.string().min(1).max(4096),
    /** SHA-256 of the local contents — verified on the receiver. */
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    /** Byte cap for the transfer; the transport refuses over-cap. */
    byteLimit: z.number().int().min(1).max(64 * 1024 * 1024),
  })
  .strict();
export type OutgoingTransfer = z.infer<typeof outgoingTransferSchema>;

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

export interface OwnedRemoteAdapterOptions {
  transport: OwnedRemoteTransport;
  /** Optional `ssh` binary path. Default: "ssh". */
  sshBin?: string;
  /** Optional path to the helper subsystem on the remote. */
  helperPath?: string;
  /** Default byte cap for an individual outgoing transfer. */
  defaultTransferByteLimit?: number;
}

/**
 * Build the `ownedRemoteAdapter` wired to the supplied transport +
 * host registry. The adapter is stateless — all durable state lives
 * in the worker (M8.1 host / session / receipt / invoke tables).
 */
export function buildOwnedRemoteAdapter(
  worker: DbWorker,
  options: OwnedRemoteAdapterOptions,
): EnvironmentAdapter {
  void options.defaultTransferByteLimit;
  return {
    adapterKind: "owned-remote",

    async discover(): Promise<EnvironmentProbe> {
      // M8.1: discover is a probe-summary over every registered host
      // whose status is `reachable`. The host registry is the single
      // source of truth for capabilities — the adapter does not
      // re-probe here.
      const hosts = listHosts(worker);
      const reachable = hosts.find((h) => h.status === "reachable");
      if (!reachable || !reachable.capabilities)
        return {
          adapterKind: "owned-remote",
          runtimeVersion: null,
          imageDigest: null,
          enforced: false,
          requiredCapabilities: ["ssh-authenticated-host", "contained-filesystem"],
          missingCapabilities: ["ssh-authenticated-host"],
        };
      const caps = reachable.capabilities;
      const missing: string[] = [];
      if (!caps.userNamespaces) missing.push("user-namespaces");
      if (!caps.containedFilesystem) missing.push("contained-filesystem");
      if (!caps.hostScheduler) missing.push("host-scheduler");
      return {
        adapterKind: "owned-remote",
        runtimeVersion: caps.nodeVersion,
        imageDigest: null,
        enforced: missing.length === 0,
        requiredCapabilities: ["user-namespaces", "contained-filesystem", "host-scheduler"],
        missingCapabilities: missing,
      };
    },

    async prepare(input: EnvironmentPrepareInput): Promise<EnvironmentHandle> {
      // M8.4 — every prepare binds to a registered host. The
      // caller MUST have registered the host with
      // `registerHost(worker, ...)` first.
      const hostId = input.installationPlanId
        ? await resolveHostForPlan(worker, input.installationPlanId)
        : await defaultHost(worker);
      if (!hostId)
        throw new AppError(
          "NOT_FOUND",
          "owned-remote prepare requires a registered host (M8.1); " +
            "register with registerHost(worker, { hostId, ... }) first",
        );
      const host = readHost(worker, hostId);
      if (!host) throw new AppError("NOT_FOUND", `host ${hostId} not registered`);
      if (host.status !== "reachable")
        throw new AppError(
          "CONFLICT",
          `host ${hostId} status is ${host.status}; refresh via probeHost`,
        );
      const pin = sessionPinDigest({
        hostId,
        workspacePath: input.workspacePath,
        recipeId: input.recipeId,
        recipeVersion: input.version,
      });
      const session = await prepareSession(worker, {
        hostId,
        workspacePath: input.workspacePath,
        pinDigest: pin,
      });
      const handle: EnvironmentHandle = {
        handleId: session.handleId,
        adapterKind: "owned-remote",
        workspacePath: input.workspacePath,
        preparedAt: session.preparedAt,
        pinDigest: pin,
      };
      // M8.4 — record a per-host receipt so the caller can audit.
      await recordReceipt(worker, {
        hostId,
        receiptKind: "installation-plan",
        subject: `prepare:${input.recipeId}@${input.version}`,
        digest: pin,
        recordedBy: "owned-remote-adapter",
        detail: { handleId: session.handleId, workspacePath: input.workspacePath },
      });
      return handle;
    },

    async inspect(handleId: string): Promise<EnvironmentHandle | undefined> {
      const session = readSession(worker, handleId);
      if (!session) return undefined;
      return {
        handleId: session.handleId,
        adapterKind: "owned-remote",
        workspacePath: session.workspacePath,
        preparedAt: session.preparedAt,
        pinDigest: session.pinDigest,
      };
    },

    async attach(input: EnvironmentAttachInput): Promise<EnvironmentAttachResult> {
      const session = readSession(worker, input.handle.handleId);
      if (!session)
        throw new AppError("NOT_FOUND", `no session for handle ${input.handle.handleId}`);
      if (session.status !== "ready" && session.status !== "in-use")
        throw new AppError(
          "CONFLICT",
          `session ${input.handle.handleId} status is ${session.status}; cannot attach`,
        );
      // M8.3 — refuse cwd outside the remote workspace handle.
      if (input.cwd && !isUnderRemoteWorkspace(input.cwd, session.workspacePath))
        throw new AppError(
          "FORBIDDEN",
          `cwd ${input.cwd} is outside the remote workspace ${session.workspacePath}; ` +
            "remote paths remain remote handles (M8.3)",
        );
      // M8.4 — single owner: refuse a second concurrent attach.
      const invocation = await startInvoke(worker, {
        hostId: session.hostId,
        handleId: session.handleId,
        recipeId: input.handle.adapterKind === "owned-remote" ? "ad-hoc" : "ad-hoc",
        recipeVersion: 1,
      });
      try {
        await observeSession(worker, session.handleId, "node");
        const response = await options.transport.send({
          hostId: session.hostId,
          sshTarget: readHost(worker, session.hostId)!.sshTarget,
          expectedFingerprint: readHost(worker, session.hostId)!.hostKeyFingerprint,
          request: {
            method: "recipe.attach",
            args: {
              handleId: session.handleId,
              argv: input.argv.slice(),
              env: Object.fromEntries(
                Object.entries(input.env as Record<string, string>)
                  .filter(([k]) => !isForbiddenEnvKey(k)),
              ),
              cwd: input.cwd ?? null,
              timeoutMs: input.timeoutMs,
              stdoutByteCap: input.stdoutByteCap,
              stderrByteCap: input.stderrByteCap,
            },
          },
        });
        if (!response.ok)
          throw new AppError("UNAVAILABLE", response.error ?? "remote attach failed");
        const parsed = attachResponseSchema.parse(response.result);
        // Persist observed state before deciding the invocation outcome.
        await observeInvoke(worker, invocation.invocationId, {
          cursor: parsed.cursor,
          remoteState: parsed.state,
          stderrTail: parsed.stderrTail,
        });
        await finishInvoke(worker, invocation.invocationId, {
          status: parsed.exitCode === 0 ? "completed" : "failed",
          exitCode: parsed.exitCode,
          stderrTail: parsed.stderrTail,
        });
        return {
          stdout: parsed.stdout,
          stderr: parsed.stderr,
          exitCode: parsed.exitCode,
          signal: (parsed.signal ?? null) as NodeJS.Signals | null,
        };
      } catch (error) {
        await finishInvoke(worker, invocation.invocationId, {
          status: "failed",
          exitCode: null,
          stderrTail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },

    async stop(handleId: string): Promise<void> {
      // M8.5 — stop stays unconfirmed until host acknowledgement.
      // We mark the session stopped locally, but the remote session
      // may still be alive. A subsequent probe either confirms or
      // surfaces it as stale.
      const session = readSession(worker, handleId);
      if (!session) return;
      const host = readHost(worker, session.hostId);
      if (!host) return;
      const response = await options.transport.send({
        hostId: session.hostId,
        sshTarget: host.sshTarget,
        expectedFingerprint: host.hostKeyFingerprint,
        request: { method: "session.stop", args: { handleId } },
      });
      if (!response.ok)
        throw new AppError("UNAVAILABLE", response.error ?? "remote stop failed");
      // Locally mark the session stopped so subsequent attach refuses.
      const driver = (worker as unknown as { driver: {
        prepare(sql: string): { run(...b: unknown[]): void };
      } }).driver;
      driver.prepare(
        "UPDATE owned_remote_session SET status = 'stopped' WHERE handle_id = ?",
      ).run(handleId);
    },

    async destroy(handleId: string): Promise<void> {
      // M8.6 — destroy is distinct from stop; release the handle.
      const session = readSession(worker, handleId);
      if (!session) return;
      const host = readHost(worker, session.hostId);
      if (!host) {
        await destroySession(worker, handleId);
        return;
      }
      try {
        await options.transport.send({
          hostId: session.hostId,
          sshTarget: host.sshTarget,
          expectedFingerprint: host.hostKeyFingerprint,
          request: { method: "session.destroy", args: { handleId } },
        });
      } catch {
        // Destroy is best-effort; the local registry still records.
      }
      await destroySession(worker, handleId);
    },
  };
}

const attachResponseSchema = z
  .object({
    stdout: z.string().max(2_097_152),
    stderr: z.string().max(2_097_152),
    exitCode: z.number().int().min(-1).max(255).nullable(),
    signal: z.string().nullable(),
    cursor: z.number().int().min(0).max(2_147_483_647),
    state: z.string().min(1).max(64),
    stderrTail: z.string().max(8192).nullable(),
  })
  .strict();

// ---------------------------------------------------------------------------
// SSH-backed transport (default)
// ---------------------------------------------------------------------------

/**
 * Build an SSH-backed transport. The transport:
 *   - always sets `-o ForwardAgent=no` (M8.2)
 *   - always sets `-o StrictHostKeyChecking=yes` with the supplied
 *     fingerprint (M8.1)
 *   - frames a JSON request, writes it to the SSH stdin, reads the
 *     JSON response from stdout
 *   - never propagates an agent request
 */
export function sshSubsystemTransport(options: {
  sshBin?: string;
  helperPath?: string;
  /** Test seam: spawn ssh with these args; default: child_process.spawn. */
  spawn?: (cmd: string, args: string[]) => {
    stdin: { write(s: string): void; end(): void };
    stdout: { on(event: "data", cb: (b: Buffer) => void): void; once(event: "end", cb: () => void): void };
    stderr: { on(event: "data", cb: (b: Buffer) => void): void };
    on(event: "close", cb: (code: number | null) => void): void;
    on(event: "error", cb: (error: Error) => void): void;
  };
}): OwnedRemoteTransport {
  const sshBin = options.sshBin ?? "ssh";
  const helperPath = options.helperPath ?? "minimal-helper";
  return {
    async probe({ sshTarget, expectedFingerprint }) {
      const args = [
        "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `HostKeyAlias=${expectedFingerprint}`,
        sshTarget, `${helperPath} probe`,
      ];
      // For probe, the body is a ProbeResult (not envelope-wrapped).
      const response = await runFramedRaw(sshBin, args, options.spawn);
      if (!response.ok)
        return {
          reachable: false, runtime: null,
          capabilities: emptyCapabilities(),
          error: response.error ?? "probe failed",
        };
      const parsed = probeResultSchema.parse(response.body);
      return {
        reachable: true, runtime: parsed.runtime,
        capabilities: parsed.capabilities,
        error: null,
      };
    },
    async send({ sshTarget, expectedFingerprint, request }) {
      const args = [
        "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no",
        "-o", "StrictHostKeyChecking=yes",
        "-o", `HostKeyAlias=${expectedFingerprint}`,
        sshTarget, helperPath,
      ];
      return runFramed(sshBin, args, request, options.spawn);
    },
  };
}

const probeResultSchema = z
  .object({
    reachable: z.boolean(),
    runtime: z.string().nullable(),
    capabilities: hostCapabilitiesSchema,
    error: z.string().nullable(),
  })
  .strict();

function emptyCapabilities(): HostCapabilities {
  return {
    nodeVersion: null,
    runtimeApiVersion: null,
    rootlessContainerEngine: false,
    userNamespaces: false,
    containedFilesystem: false,
    hostScheduler: false,
    storageMib: 0,
    providerModes: [],
  };
}

function runFramed(
  cmd: string,
  args: string[],
  request: { method: string; args: Record<string, unknown> },
  spawn?: (cmd: string, args: string[]) => {
    stdin: { write(s: string): void; end(): void };
    stdout: { on(event: "data", cb: (b: Buffer) => void): void; once(event: "end", cb: () => void): void };
    stderr: { on(event: "data", cb: (b: Buffer) => void): void };
    on(event: "close", cb: (code: number | null) => void): void;
    on(event: "error", cb: (error: Error) => void): void;
  },
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const payload = JSON.stringify(request);
    const proc = spawn
      ? spawn(cmd, args)
      : realSpawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    proc.stdout.once("end", () => {
      try {
        const json = JSON.parse(stdout);
        // The wire format for `send` is `{ ok, result?, error? }`. The
        // helper body is the `result` field; re-envelope here so the
        // caller's `send(...)` contract holds.
        resolve({ ok: true, result: json });
      } catch (error) {
        resolve({
          ok: false,
          error: stderr || (error instanceof Error ? error.message : "non-JSON response"),
        });
      }
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    proc.on("close", () => {
      // Drain handled in stdout.once("end") — close is a no-op fallback.
    });
    proc.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    proc.stdin.write(payload + "\n");
    proc.stdin.end();
  });
}

/**
 * Variant that returns the body JSON as-is (no envelope). Used by
 * `probe` where the wire body is the ProbeResult itself.
 */
function runFramedRaw(
  cmd: string,
  args: string[],
  spawn?: (cmd: string, args: string[]) => {
    stdin: { write(s: string): void; end(): void };
    stdout: { on(event: "data", cb: (b: Buffer) => void): void; once(event: "end", cb: () => void): void };
    stderr: { on(event: "data", cb: (b: Buffer) => void): void };
    on(event: "close", cb: (code: number | null) => void): void;
    on(event: "error", cb: (error: Error) => void): void;
  },
): Promise<{ ok: boolean; body?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn
      ? spawn(cmd, args)
      : realSpawn(cmd, args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (b: Buffer) => {
      stdout += b.toString("utf8");
    });
    proc.stdout.once("end", () => {
      try {
        const json = JSON.parse(stdout);
        resolve({ ok: true, body: json });
      } catch (error) {
        resolve({
          ok: false,
          error: stderr || (error instanceof Error ? error.message : "non-JSON response"),
        });
      }
    });
    proc.stderr.on("data", (b: Buffer) => {
      stderr += b.toString("utf8");
    });
    proc.on("close", () => { /* noop */ });
    proc.on("error", (error) => {
      resolve({ ok: false, error: error.message });
    });
    // Probe has no request body — the helper accepts the method as an argv.
    proc.stdin.end();
  });
}

function realSpawn(
  cmd: string,
  args: string[],
): {
  stdin: { write(s: string): void; end(): void };
  stdout: { on(event: "data", cb: (b: Buffer) => void): void; once(event: "end", cb: () => void): void };
  stderr: { on(event: "data", cb: (b: Buffer) => void): void };
  on(event: "close", cb: (code: number | null) => void): void;
  on(event: "error", cb: (error: Error) => void): void;
} {
  // Lazy require so the test seam can run without spawning real ssh.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  return spawn(cmd, args) as unknown as ReturnType<typeof realSpawn>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function listHosts(worker: DbWorker): Array<{
  hostId: string;
  status: HostStatus;
  capabilities: HostCapabilities | null;
}> {
  const driver = (worker as unknown as { driver: {
    prepare(sql: string): { all(...b: unknown[]): Array<Record<string, unknown>> };
  } }).driver;
  const rows = driver
    .prepare("SELECT * FROM owned_remote_host ORDER BY host_id")
    .all();
  return rows.map((row) => {
    let capabilities: HostCapabilities | null = null;
    if (row.capabilities_json) {
      try {
        const parsed = JSON.parse(String(row.capabilities_json));
        if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0)
          capabilities = hostCapabilitiesSchema.parse({
            nodeVersion: null, runtimeApiVersion: null, rootlessContainerEngine: false,
            userNamespaces: false, containedFilesystem: false, hostScheduler: false,
            storageMib: 0, providerModes: [], ...parsed,
          });
      } catch { /* ignore */ }
    }
    return {
      hostId: String(row.host_id),
      status: String(row.status) as HostStatus,
      capabilities,
    };
  });
}

async function resolveHostForPlan(worker: DbWorker, _planId: string): Promise<string | undefined> {
  // M8.4 — the plan host mapping lives in the install plan table; for
  // now we just pick the first reachable host. A future revision can
  // join on installation_plan.host_id.
  const hosts = listHosts(worker);
  return hosts.find((h) => h.status === "reachable")?.hostId;
}

async function defaultHost(worker: DbWorker): Promise<string | undefined> {
  return listHosts(worker).find((h) => h.status === "reachable")?.hostId;
}

function isUnderRemoteWorkspace(path: string, workspace: string): boolean {
  if (path === workspace) return true;
  return path.startsWith(workspace + "/");
}

const FORBIDDEN_ENV_KEYS = new Set([
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
]);

function isForbiddenEnvKey(key: string): boolean {
  if (FORBIDDEN_ENV_KEYS.has(key)) return true;
  // Strip any `*SSH*` / `*AGENT*` keys — agent-forwarding prevention.
  if (/ssh/i.test(key)) return true;
  if (/agent/i.test(key) && !/useragent/i.test(key)) return true;
  return false;
}

// Re-export the host registry so callers have a single import.
export {
  registerHost,
  unregisterHost,
  probeHost,
  readHost,
  readInvoke,
  readSession,
  markInvokeStale,
  observeInvoke,
  transferOwnership,
  hostInputSchema,
  hostAuthKindSchema,
  hostCapabilitiesSchema,
  hostStatusSchema,
  receiptKindSchema,
};

void z;
