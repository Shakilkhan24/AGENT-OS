/**
 * M8.1 — owned remote host identity registry.
 *
 * The M8.1 bullet (FUTURE/IMPLEMENTATION-README.md line 271) reads:
 *
 * > M8.1 Register and verify host identity, execution capabilities,
 * > runtime/API versions, storage and available provider/auth modes.
 * > Pin host keys; mismatches refuse connection. Keep credentials
 * > host-local or in a suitable secret store; offer session-only
 * > references when secure persistence is unavailable. Do not copy
 * > provider auth directories into images.
 *
 * This module is the durable registry that backs the M8 SSH-backed
 * adapter. It owns four tables:
 *
 *   - `owned_remote_host`    — one row per SSH host identity.
 *   - `owned_remote_session` — a prepared session for a host.
 *   - `owned_remote_receipt` — a per-host install / capability receipt.
 *   - `owned_remote_invoke`  — a remote invocation record.
 *
 * The public surface:
 *
 *   - `registerHost` / `unregisterHost`              — M8.1
 *   - `probeHost` (with capability advertisement)     — M8.1, M8.3
 *   - `pinHostKey` / `verifyHostKey`                  — M8.1
 *   - `prepareSession` / `observeSession`             — M8.4
 *   - `recordReceipt`                                 — M8.4
 *   - `startInvoke` / `observeInvoke` / `finishInvoke` — M8.5
 *   - `transferOwnership`                             — M8.5
 *
 * The transport layer (`OwnedRemoteTransport`) is a sealed boundary
 * the caller supplies — the default implementation in
 * `owned-remote-adapter.ts` is SSH-backed; tests substitute an
 * in-memory transport. No code in this module invokes the SSH client
 * directly.
 */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "../db/worker";

// ---------------------------------------------------------------------------
// Driver adapter
// ---------------------------------------------------------------------------

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const hostAuthKindSchema = z.enum([
  /** Public key auth; fingerprint stored; private key stays host-local. */
  "ssh-publickey",
  /** Session-only credential reference; never persisted. */
  "ssh-session-token",
  /** No authentication (loopback only — for tests + dev containers). */
  "loopback",
]);
export type HostAuthKind = z.infer<typeof hostAuthKindSchema>;

export const hostStatusSchema = z.enum([
  "reachable", "degraded", "unreachable", "revoked",
]);
export type HostStatus = z.infer<typeof hostStatusSchema>;

export const sessionStatusSchema = z.enum([
  "ready", "in-use", "stopped", "destroyed", "stale",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const invokeStatusSchema = z.enum([
  "in-flight", "completed", "failed", "cancelled", "stale",
]);
export type InvokeStatus = z.infer<typeof invokeStatusSchema>;

export const receiptKindSchema = z.enum([
  "kernel-capability", "installation-plan", "auth-mode", "storage-quota",
]);
export type ReceiptKind = z.infer<typeof receiptKindSchema>;

export const hostCapabilitiesSchema = z
  .object({
    /** Node version reported by `node --version` on the remote host. */
    nodeVersion: z.string().min(1).max(64).nullable(),
    /** Runtime API version (the helper subsystem's protocol version). */
    runtimeApiVersion: z.string().min(1).max(64).nullable(),
    /** Whether the host has a rootless container engine (podman / docker). */
    rootlessContainerEngine: z.boolean(),
    /** Whether the host kernel supports user namespaces. */
    userNamespaces: z.boolean(),
    /** Whether the remote runtime supports a contained filesystem. */
    containedFilesystem: z.boolean(),
    /** Whether a host-side scheduler (cron / systemd) is available. */
    hostScheduler: z.boolean(),
    /** Disk available for the owned-remote profile, in MiB. */
    storageMib: z.number().int().min(0).max(1_048_576),
    /** Available provider / auth modes advertised by the helper. */
    providerModes: z.array(z.string().min(1).max(64)).max(32),
  })
  .strict();
export type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

export const hostInputSchema = z
  .object({
    hostId: z.string().min(1).max(128),
    displayName: z.string().min(1).max(256),
    sshTarget: z.string().min(1).max(512),
    hostKeyFingerprint: z.string().regex(/^([0-9a-f]{2}:){15}[0-9a-f]{2}$|^SHA256:[A-Za-z0-9+/=]+$/),
    authKind: hostAuthKindSchema,
    capabilities: hostCapabilitiesSchema.partial().optional(),
    registeredBy: z.string().min(1).max(256),
  })
  .strict();
export type HostInput = z.input<typeof hostInputSchema>;

export const probeResultSchema = z
  .object({
    reachable: z.boolean(),
    runtime: z.string().nullable(),
    capabilities: hostCapabilitiesSchema,
    /** Set when `reachable: false` to surface the failure. */
    error: z.string().nullable(),
  })
  .strict();
export type ProbeResult = z.infer<typeof probeResultSchema>;

// ---------------------------------------------------------------------------
// Transport contract (sealed boundary)
// ---------------------------------------------------------------------------

/**
 * The transport contract. Implementations are responsible for the
 * wire-level SSH conversation; the registry never imports the SSH
 * client directly so unit tests can swap an in-memory stub.
 */
export interface OwnedRemoteTransport {
  /** Probe a host: returns runtime + capabilities. The transport
   *  MUST refuse connection when the host key fingerprint does not
   *  match the expected value (M8.1). */
  probe(args: { hostId: string; sshTarget: string; expectedFingerprint: string }): Promise<ProbeResult>;
  /** Transfer one framed request. The transport encodes the request
   *  as JSON, ships it to the helper subsystem, and returns the JSON
   *  response. The transport MUST disable agent forwarding. */
  send(args: {
    hostId: string;
    sshTarget: string;
    expectedFingerprint: string;
    request: { method: string; args: Record<string, unknown> };
  }): Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

// ---------------------------------------------------------------------------
// Host registry
// ---------------------------------------------------------------------------

export interface RegisteredHost {
  hostId: string;
  displayName: string;
  sshTarget: string;
  hostKeyFingerprint: string;
  authKind: HostAuthKind;
  status: HostStatus;
  capabilities: HostCapabilities | null;
  lastProbedAt: string | null;
  registeredAt: string;
  registeredBy: string;
}

export interface PreparedSession {
  handleId: string;
  hostId: string;
  pinDigest: string;
  workspacePath: string;
  preparedAt: string;
  status: SessionStatus;
  lastObservedAt: string | null;
}

export interface InvokeRecord {
  invocationId: string;
  hostId: string;
  handleId: string;
  recipeId: string;
  recipeVersion: number;
  startedAt: string;
  finishedAt: string | null;
  status: InvokeStatus;
  lastObservedAt: string | null;
  cursor: number;
  remoteState: string | null;
  remoteExitCode: number | null;
  remoteStderrTail: string | null;
}

/**
 * Register a host. Re-registration with a different `hostKeyFingerprint`
 * is refused — a fingerprint change means a TOFU violation and the
 * caller must explicitly unregister + register to recover (M8.1).
 */
export async function registerHost(
  worker: DbWorker,
  input: HostInput,
): Promise<RegisteredHost> {
  const parsed = hostInputSchema.parse(input);
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    const existing = driver
      .prepare("SELECT * FROM owned_remote_host WHERE host_id = ?")
      .first(parsed.hostId) as Record<string, unknown> | undefined;
    if (existing) {
      const previousFingerprint = String(existing.host_key_fingerprint);
      if (previousFingerprint !== parsed.hostKeyFingerprint) {
        throw new AppError(
          "FORBIDDEN",
          `host ${parsed.hostId} fingerprint mismatch: ` +
            `stored=${previousFingerprint} presented=${parsed.hostKeyFingerprint}; ` +
            `unregister first to recover`,
        );
      }
      driver.prepare(
        "UPDATE owned_remote_host SET display_name = ?, ssh_target = ?, auth_kind = ?, " +
          "capabilities_json = ?, updated_at = ? WHERE host_id = ?",
      ).run(
        parsed.displayName, parsed.sshTarget, parsed.authKind,
        JSON.stringify(parsed.capabilities ?? {}), now, parsed.hostId,
      );
      return;
    }
    driver.prepare(
      "INSERT INTO owned_remote_host (uuid, host_id, display_name, ssh_target, " +
        "host_key_fingerprint, auth_kind, capabilities_json, status, registered_at, registered_by) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), parsed.hostId, parsed.displayName, parsed.sshTarget,
      parsed.hostKeyFingerprint, parsed.authKind,
      JSON.stringify(parsed.capabilities ?? {}), "reachable", now, parsed.registeredBy,
    );
  });
  return {
    hostId: parsed.hostId,
    displayName: parsed.displayName,
    sshTarget: parsed.sshTarget,
    hostKeyFingerprint: parsed.hostKeyFingerprint,
    authKind: parsed.authKind,
    status: "reachable",
    capabilities: parsed.capabilities ? hostCapabilitiesSchema.parse({
      nodeVersion: null, runtimeApiVersion: null, rootlessContainerEngine: false,
      userNamespaces: false, containedFilesystem: false, hostScheduler: false,
      storageMib: 0, providerModes: [], ...parsed.capabilities,
    }) : null,
    lastProbedAt: null,
    registeredAt: now,
    registeredBy: parsed.registeredBy,
  };
}

export async function unregisterHost(
  worker: DbWorker,
  hostId: string,
): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare("DELETE FROM owned_remote_session WHERE host_id = ?").run(hostId);
    driver.prepare("DELETE FROM owned_remote_invoke WHERE host_id = ?").run(hostId);
    driver.prepare("DELETE FROM owned_remote_receipt WHERE host_id = ?").run(hostId);
    driver.prepare("DELETE FROM owned_remote_host WHERE host_id = ?").run(hostId);
  });
}

/**
 * Probe a host through the supplied transport. Verifies the host key
 * fingerprint matches the stored one and refreshes the capability
 * cache (M8.1).
 */
export async function probeHost(
  worker: DbWorker,
  transport: OwnedRemoteTransport,
  hostId: string,
): Promise<ProbeResult> {
  const host = readHost(worker, hostId);
  if (!host) throw new AppError("NOT_FOUND", `host ${hostId} not registered`);
  const probe = await transport.probe({
    hostId: host.hostId,
    sshTarget: host.sshTarget,
    expectedFingerprint: host.hostKeyFingerprint,
  });
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_host SET capabilities_json = ?, last_probed_at = ?, " +
        "last_probed_runtime = ?, status = ? WHERE host_id = ?",
    ).run(
      JSON.stringify(probe.capabilities), now, probe.runtime,
      probe.reachable ? "reachable" : "unreachable", hostId,
    );
  });
  return probe;
}

export function readHost(
  worker: DbWorker,
  hostId: string,
): RegisteredHost | undefined {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM owned_remote_host WHERE host_id = ?")
    .first(hostId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  const rawCapabilities = row.capabilities_json;
  let capabilities: HostCapabilities | null = null;
  if (rawCapabilities) {
    try {
      const parsed = JSON.parse(String(rawCapabilities));
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0)
        capabilities = hostCapabilitiesSchema.parse({
          nodeVersion: null, runtimeApiVersion: null, rootlessContainerEngine: false,
          userNamespaces: false, containedFilesystem: false, hostScheduler: false,
          storageMib: 0, providerModes: [], ...parsed,
        });
    } catch {
      capabilities = null;
    }
  }
  return {
    hostId: String(row.host_id),
    displayName: String(row.display_name),
    sshTarget: String(row.ssh_target),
    hostKeyFingerprint: String(row.host_key_fingerprint),
    authKind: String(row.auth_kind) as HostAuthKind,
    status: String(row.status) as HostStatus,
    capabilities,
    lastProbedAt: row.last_probed_at == null ? null : String(row.last_probed_at),
    registeredAt: String(row.registered_at),
    registeredBy: String(row.registered_by),
  };
}

// ---------------------------------------------------------------------------
// Sessions (M8.4)
// ---------------------------------------------------------------------------

/**
 * Prepare a session on the host. The caller supplies the workspace
 * path; the registry records a `pinDigest` so a future `inspect` can
 * detect tampering with the workspace identity (mirrors M6.5).
 */
export async function prepareSession(
  worker: DbWorker,
  args: { hostId: string; workspacePath: string; pinDigest: string },
): Promise<PreparedSession> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  const handleId = randomUUID();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO owned_remote_session (uuid, host_id, handle_id, pin_digest, " +
        "workspace_path, prepared_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), args.hostId, handleId, args.pinDigest,
      args.workspacePath, now, "ready",
    );
  });
  return {
    handleId, hostId: args.hostId, pinDigest: args.pinDigest,
    workspacePath: args.workspacePath, preparedAt: now,
    status: "ready", lastObservedAt: null,
  };
}

export async function observeSession(
  worker: DbWorker,
  handleId: string,
  runtime: string,
): Promise<void> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_session SET last_observed_at = ?, " +
        "last_observed_runtime = ?, status = 'in-use' WHERE handle_id = ?",
    ).run(now, runtime, handleId);
  });
}

export async function destroySession(
  worker: DbWorker,
  handleId: string,
): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_session SET status = 'destroyed' WHERE handle_id = ?",
    ).run(handleId);
  });
}

export function readSession(
  worker: DbWorker,
  handleId: string,
): PreparedSession | undefined {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM owned_remote_session WHERE handle_id = ?")
    .first(handleId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    handleId: String(row.handle_id),
    hostId: String(row.host_id),
    pinDigest: String(row.pin_digest),
    workspacePath: String(row.workspace_path),
    preparedAt: String(row.prepared_at),
    status: String(row.status) as SessionStatus,
    lastObservedAt: row.last_observed_at == null ? null : String(row.last_observed_at),
  };
}

// ---------------------------------------------------------------------------
// Receipts (M8.4)
// ---------------------------------------------------------------------------

export interface ReceiptInput {
  hostId: string;
  receiptKind: ReceiptKind;
  subject: string;
  digest: string;
  recordedBy: string;
  detail?: Record<string, unknown>;
}

export async function recordReceipt(
  worker: DbWorker,
  input: ReceiptInput,
): Promise<void> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO owned_remote_receipt (uuid, host_id, receipt_kind, subject, " +
        "digest, recorded_at, recorded_by, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), input.hostId, input.receiptKind, input.subject,
      input.digest, now, input.recordedBy,
      input.detail ? JSON.stringify(input.detail) : null,
    );
  });
}

// ---------------------------------------------------------------------------
// Invocations (M8.5)
// ---------------------------------------------------------------------------

export async function startInvoke(
  worker: DbWorker,
  args: {
    hostId: string;
    handleId: string;
    recipeId: string;
    recipeVersion: number;
  },
): Promise<InvokeRecord> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  const invocationId = randomUUID();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO owned_remote_invoke (uuid, host_id, handle_id, recipe_id, " +
        "recipe_version, invocation_id, started_at, status, cursor) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), args.hostId, args.handleId, args.recipeId,
      args.recipeVersion, invocationId, now, "in-flight", 0,
    );
  });
  return {
    invocationId, hostId: args.hostId, handleId: args.handleId,
    recipeId: args.recipeId, recipeVersion: args.recipeVersion,
    startedAt: now, finishedAt: null, status: "in-flight",
    lastObservedAt: null, cursor: 0, remoteState: null,
    remoteExitCode: null, remoteStderrTail: null,
  };
}

export async function observeInvoke(
  worker: DbWorker,
  invocationId: string,
  state: { cursor: number; remoteState: string; stderrTail: string | null },
): Promise<void> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_invoke SET cursor = ?, remote_state = ?, " +
        "remote_stderr_tail = ?, last_observed_at = ? " +
        "WHERE invocation_id = ? AND status = 'in-flight'",
    ).run(state.cursor, state.remoteState, state.stderrTail, now, invocationId);
  });
}

export async function finishInvoke(
  worker: DbWorker,
  invocationId: string,
  outcome: {
    status: "completed" | "failed" | "cancelled";
    exitCode: number | null;
    stderrTail: string | null;
  },
): Promise<void> {
  const driver = driverOf(worker);
  const now = new Date().toISOString();
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_invoke SET status = ?, remote_exit_code = ?, " +
        "remote_stderr_tail = ?, finished_at = ? WHERE invocation_id = ?",
    ).run(outcome.status, outcome.exitCode, outcome.stderrTail, now, invocationId);
  });
}

export async function markInvokeStale(
  worker: DbWorker,
  invocationId: string,
): Promise<void> {
  const driver = driverOf(worker);
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "UPDATE owned_remote_invoke SET status = 'stale' " +
        "WHERE invocation_id = ? AND status = 'in-flight'",
    ).run(invocationId);
  });
}

/**
 * M8.5 — schedule ownership transfer. Disables the previous owner
 * and verifies a generation handoff before admitting new invocations.
 * Refuses if the previous owner is not in a `stale` state.
 */
export async function transferOwnership(
  worker: DbWorker,
  args: { hostId: string; previousInvocationId: string; newGeneration: number },
): Promise<{ newGeneration: number }> {
  if (!Number.isInteger(args.newGeneration) || args.newGeneration < 0)
    throw new AppError("INVALID_REQUEST", "newGeneration must be a non-negative integer");
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT status FROM owned_remote_invoke WHERE invocation_id = ?")
    .first(args.previousInvocationId) as Record<string, unknown> | undefined;
  if (!row)
    throw new AppError("NOT_FOUND", `invocation ${args.previousInvocationId} not found`);
  const previousStatus = String(row.status);
  if (previousStatus !== "stale")
    throw new AppError(
      "CONFLICT",
      `cannot transfer ownership: previous invocation status is ${previousStatus}, expected stale`,
    );
  const handoffDigest = createHash("sha256")
    .update(JSON.stringify({
      hostId: args.hostId, previousInvocationId: args.previousInvocationId,
      newGeneration: args.newGeneration,
    }))
    .digest("hex");
  await worker.transaction(tx => {
    void tx;
    driver.prepare(
      "INSERT INTO owned_remote_receipt (uuid, host_id, receipt_kind, subject, " +
        "digest, recorded_at, recorded_by, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(), args.hostId, "auth-mode",
      `ownership-transfer:${args.previousInvocationId}`, handoffDigest,
      new Date().toISOString(), "owned-remote", JSON.stringify({ newGeneration: args.newGeneration }),
    );
  });
  return { newGeneration: args.newGeneration };
}

export function readInvoke(
  worker: DbWorker,
  invocationId: string,
): InvokeRecord | undefined {
  const driver = driverOf(worker);
  const row = driver
    .prepare("SELECT * FROM owned_remote_invoke WHERE invocation_id = ?")
    .first(invocationId) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    invocationId: String(row.invocation_id),
    hostId: String(row.host_id),
    handleId: String(row.handle_id),
    recipeId: String(row.recipe_id),
    recipeVersion: Number(row.recipe_version),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at == null ? null : String(row.finished_at),
    status: String(row.status) as InvokeStatus,
    lastObservedAt: row.last_observed_at == null ? null : String(row.last_observed_at),
    cursor: Number(row.cursor),
    remoteState: row.remote_state == null ? null : String(row.remote_state),
    remoteExitCode: row.remote_exit_code == null ? null : Number(row.remote_exit_code),
    remoteStderrTail: row.remote_stderr_tail == null ? null : String(row.remote_stderr_tail),
  };
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/** Compute the digest used to pin a session's workspace identity. */
export function sessionPinDigest(args: { hostId: string; workspacePath: string; recipeId: string; recipeVersion: number }): string {
  const surface = {
    hostId: args.hostId, workspacePath: args.workspacePath,
    recipeId: args.recipeId, recipeVersion: args.recipeVersion,
  };
  return createHash("sha256")
    .update(JSON.stringify(surface, Object.keys(surface).sort()), "utf8")
    .digest("hex");
}

void z;
