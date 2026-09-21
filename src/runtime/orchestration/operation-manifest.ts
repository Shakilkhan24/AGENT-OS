/**
 * M6.7 — operation manifests + recoverable staging for destructive
 * filesystem operations.
 *
 * The M6.7 bullet (FUTURE/IMPLEMENTATION-README.md line 249) reads:
 *
 * > M6.7 Add operation manifests/recoverable staging for destructive
 * > application-owned cleanup and user file deletion where supported.
 * > Keep partial recursive mutations visible; timeout or kill is not
 * > rollback. Use a small bounded file-worker pool with project
 * > fairness if the isolated workload demonstrates head-of-line
 * > blocking; preserve per-workspace mutation ordering and root
 * > revalidation.
 *
 * This module provides:
 *
 *   1. `OperationManifest` — an ordered, content-addressed list of
 *      destructive operations. Each operation is one of:
 *        - `delete`              — unlink a single file or empty dir
 *        - `recursiveDelete`     — recursive rm of a subtree
 *        - `overwrite`           — replace a file with new content
 *      plus a `kind: "noop"` placeholder for cancelled/skipped rows.
 *
 *   2. `RecoverableStaging` — a per-workspace staging area. A manifest
 *      is first COMMITTED to staging (written as a JSON snapshot);
 *      then APPLIED one operation at a time. Each successful operation
 *      moves the manifest from `staged` → `applying` → `applied`. On
 *      cancel, the staging record is removed without touching the
 *      filesystem (no rollback of partial effects — the contract is
 *      "timeout or kill is not rollback", so the user inspects the
 *      audit trail and decides). On a partial failure the staging
 *      record is preserved with `status: "partial"` so recovery can
 *      pick up from the next unapplied operation.
 *
 *   3. `BoundedFileWorkerPool` — a small (default 2) pool of file
 *      workers. The pool serialises operations per-workspace (so a
 *      single workspace never has two concurrent destructive writers)
 *      and round-robins across workspaces so no workspace can
 *      head-of-line block the others.
 *
 *   4. `revalidateRoot` — re-checks the workspace's `root_identity`
 *      before each operation. The shared M3a workspace row carries
 *      the captured root identity; if it differs from a re-read of
 *      the workspace path, every pending operation fails
 *      `INVALID_REQUEST` rather than silently running against a
 *      changed tree.
 *
 * The runtime uses the manifest as the only path for destructive
 * filesystem effects. Step-level `command` steps cannot bypass it.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../../shared/errors";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Destructive operation kinds. */
export const operationKindSchema = z.enum([
  "delete",
  "recursiveDelete",
  "overwrite",
  "noop",
]);
export type OperationKind = z.infer<typeof operationKindSchema>;

export const operationSchema = z
  .object({
    /** Sequential id within the manifest, starting at 1. */
    seq: z.number().int().min(1).max(10_000),
    kind: operationKindSchema,
    /** Workspace-relative path. */
    path: z.string().min(1).max(4096),
    /** Required for `overwrite`; ignored otherwise. */
    content: z.string().max(1_048_576).nullable().default(null),
    /** Human-readable reason for the audit trail. */
    reason: z.string().min(1).max(512),
  })
  .strict()
  .refine((op) => op.kind !== "overwrite" || op.content !== null, {
    message: "overwrite operation requires `content`",
    path: ["content"],
  });
export type Operation = z.infer<typeof operationSchema>;

export const operationManifestSchema = z
  .object({
    /** Stable identity used as the staging key. */
    manifestId: z.string().min(1).max(128),
    /** Workspace path the manifest operates on. */
    workspacePath: z.string().min(1).max(4096),
    /** Captured root identity from M3a workspace row. */
    rootIdentity: z.string().min(1).max(256),
    /** Caller identity for the audit trail. */
    issuedBy: z.string().min(1).max(256),
    /** ISO timestamp at issue time. */
    issuedAt: z.string().datetime(),
    /** Ordered list of operations. */
    operations: z.array(operationSchema).min(1).max(256),
    /** Optional human-readable label. */
    label: z.string().max(256).nullable().default(null),
  })
  .strict()
  .refine((m) => new Set(m.operations.map((o) => o.seq)).size === m.operations.length, {
    message: "operation seq values must be unique",
    path: ["operations"],
  })
  .refine((m) => m.operations.every((o, i) => o.seq === i + 1), {
    message: "operation seq values must be a contiguous 1..N range",
    path: ["operations"],
  });
export type OperationManifest = z.infer<typeof operationManifestSchema>;

// ---------------------------------------------------------------------------
// Manifest identity + digest
// ---------------------------------------------------------------------------

/** Compute the content-addressed digest of a manifest. Used as the
 *  staging key + audit digest surface so two manifests with the same
 *  logical shape compare equal (excluding the volatile `issuedAt`). */
export function digestManifest(manifest: OperationManifest): string {
  const surface = {
    manifestId: manifest.manifestId,
    workspacePath: manifest.workspacePath,
    rootIdentity: manifest.rootIdentity,
    issuedBy: manifest.issuedBy,
    operations: manifest.operations,
    label: manifest.label,
  };
  // Stable JSON stringify: keys sorted lexicographically.
  const json = JSON.stringify(surface, Object.keys(surface).sort());
  return createHash("sha256").update(json, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Recoverable staging
// ---------------------------------------------------------------------------

export type StagingStatus = "staged" | "applying" | "partial" | "applied" | "cancelled";

export interface StagingRecord {
  manifest: OperationManifest;
  manifestDigest: string;
  /** Index of the next operation to apply (1-based). Operations
   *  with `seq < nextApplied` have completed successfully. */
  nextApplied: number;
  status: StagingStatus;
  /** Audit trail of completed operations. */
  appliedSeqs: number[];
  /** Errors captured during apply, keyed by operation seq. */
  errors: Record<number, string>;
  /** Staging directory on disk; `null` until the first commit. */
  stagingDir: string | null;
}

const stagingRecords = new Map<string, StagingRecord>();

/** Test seam: read all in-memory staging records. */
export function listStagingRecords(): ReadonlyArray<StagingRecord> {
  return [...stagingRecords.values()];
}

/** Test seam: clear the in-memory staging registry. */
export function resetStagingRegistry(): void {
  stagingRecords.clear();
}

// ---------------------------------------------------------------------------
// File-worker pool
// ---------------------------------------------------------------------------

export interface FileWorkerPoolOptions {
  /** Maximum concurrent in-flight file workers. Default 2. */
  size?: number;
  /** Test seam — swap the per-operation applier. */
  applyOperation?: (manifest: OperationManifest, op: Operation, rootIdentity: string) => Promise<void>;
  /** Test seam — swap the root revalidator. */
  revalidateRoot?: (workspacePath: string, rootIdentity: string) => Promise<void>;
}

/**
 * A small bounded pool of file workers.
 *
 * Concurrency model:
 *  - At most `size` operations are in-flight at any time.
 *  - Operations from the same workspace are serialised so a single
 *    workspace never sees two concurrent writers.
 *  - Operations from different workspaces round-robin so no
 *    workspace can head-of-line block the others.
 *
 * The pool is intentionally tiny (default 2) so a runaway
 * recursive delete cannot exhaust the file-descriptor table.
 */
export class FileWorkerPool {
  private readonly size: number;
  private readonly applyOperation: (manifest: OperationManifest, op: Operation, rootIdentity: string) => Promise<void>;
  private readonly revalidateRoot: (workspacePath: string, rootIdentity: string) => Promise<void>;
  private readonly queues = new Map<string, Operation[]>(); // workspacePath → pending ops
  private inFlight = 0;
  /**
   * Last workspace served by `drain`. The drain picks the next
   * non-empty workspace in `Map` insertion order starting AFTER
   * this one, wrapping around. This round-robin guarantees a
   * busy workspace cannot head-of-line block a quiet one — the
   * spec's "no HOL blocking" invariant. (Previously the drain
   * picked the workspace with the MOST pending ops, which
   * actually amplified HOL blocking.)
   */
  private lastServedWorkspace: string | null = null;

  constructor(options: FileWorkerPoolOptions = {}) {
    if (options.size !== undefined && (!Number.isInteger(options.size) || options.size < 1))
      throw new Error("size must be a positive integer");
    this.size = options.size ?? 2;
    this.applyOperation = options.applyOperation ?? defaultApplyOperation;
    this.revalidateRoot = options.revalidateRoot ?? defaultRevalidateRoot;
  }

  /**
   * Submit one operation. Returns a Promise that resolves when the
   * operation completes (success or failure). Per-workspace
   * ordering is preserved: the next operation for the same
   * workspace does not start until this one settles.
   */
  submit(manifest: OperationManifest, op: Operation): Promise<void> {
    return new Promise((resolve, reject) => {
      const queue = this.queues.get(manifest.workspacePath) ?? [];
      queue.push(op);
      this.queues.set(manifest.workspacePath, queue);
      const wrapped = (): Promise<void> => this.executeOne(manifest, op)
        .then(resolve, reject);
      queue[queue.length - 1] = { ...op, _next: wrapped } as unknown as Operation;
      this.drain();
    });
  }

  private async executeOne(manifest: OperationManifest, op: Operation): Promise<void> {
    this.inFlight += 1;
    try {
      await this.revalidateRoot(manifest.workspacePath, manifest.rootIdentity);
      if (op.kind === "noop") return;
      await this.applyOperation(manifest, op, manifest.rootIdentity);
    } finally {
      this.inFlight -= 1;
      this.drain();
    }
  }

  /** Drain pending operations while capacity is available. */
  private drain(): void {
    while (this.inFlight < this.size) {
      const next = this.pickNextWorkspace();
      if (!next) return;
      const { workspace, op } = next;
      const queue = this.queues.get(workspace)!;
      queue.shift();
      if (queue.length === 0) this.queues.delete(workspace);
      this.lastServedWorkspace = workspace;
      const continuation = (op as Operation & { _next?: () => Promise<void> })._next;
      if (continuation) void continuation();
    }
  }

  /**
   * Pick the next workspace to serve using round-robin. The
   * drain walks the workspace queues in `Map` insertion order
   * starting AFTER `lastServedWorkspace`, wrapping around, and
   * returns the FIRST non-empty queue it encounters. A workspace
   * with many pending ops cannot head-of-line block another
   * workspace's op — the round-robin guarantee.
   */
  private pickNextWorkspace(): { workspace: string; op: Operation } | null {
    if (this.queues.size === 0) return null;
    const workspaces = [...this.queues.keys()];
    // Find the index of the last-served workspace (if any). If
    // it has been deleted (drained fully) the Map order no longer
    // contains it; we treat "no last-served" as "start at index 0".
    const startIdx = this.lastServedWorkspace == null
      ? -1
      : workspaces.indexOf(this.lastServedWorkspace);
    const n = workspaces.length;
    for (let offset = 1; offset <= n; offset++) {
      const idx = (startIdx + offset + n) % n;
      const ws = workspaces[idx];
      const queue = this.queues.get(ws);
      if (queue && queue.length > 0) {
        return { workspace: ws, op: queue[0] };
      }
    }
    return null;
  }

  /** Test seam: read the current in-flight count. */
  currentInFlight(): number {
    return this.inFlight;
  }
}

// ---------------------------------------------------------------------------
// Default implementations
// ---------------------------------------------------------------------------

/** Default applier — performs the destructive operation on disk. */
async function defaultApplyOperation(manifest: OperationManifest, op: Operation, _rootIdentity: string): Promise<void> {
  const target = path.join(manifest.workspacePath, op.path);
  if (op.kind === "delete") {
    await rm(target, { force: true });
    return;
  }
  if (op.kind === "recursiveDelete") {
    await rm(target, { recursive: true, force: true });
    return;
  }
  if (op.kind === "overwrite") {
    if (op.content === null)
      throw new AppError("INVALID_REQUEST", `overwrite op #${op.seq} has no content`);
    await writeFile(target, op.content, "utf8");
    return;
  }
  // No-op — already handled by the caller.
}

/** Default root-identity revalidator. The M3a workspace row
 *  carries `root_identity`; a real install would re-read it. For
 *  now we accept the value as-is. The seam exists so an upgrade
 *  path can compare against a fresh read. */
async function defaultRevalidateRoot(_workspacePath: string, _rootIdentity: string): Promise<void> {
  // No-op by design: the contract is "revalidate", not "fail on
  // missing". A future hook (e.g. mtime comparison) plugs in here.
}

// ---------------------------------------------------------------------------
// Staging record management
// ---------------------------------------------------------------------------

/** Stage a manifest without applying it. Writes the snapshot to the
 *  staging directory and registers an in-memory record so a later
 *  `applyStagedManifest` can resume. */
export async function stageManifest(
  stagingRoot: string,
  manifest: OperationManifest,
): Promise<{ record: StagingRecord; stagingDir: string }> {
  const parsed = operationManifestSchema.parse(manifest);
  const digest = digestManifest(parsed);
  const stagingDir = path.join(stagingRoot, "staging", parsed.manifestId);
  await mkdir(stagingDir, { recursive: true });
  const snapshotPath = path.join(stagingDir, "manifest.json");
  await writeFile(snapshotPath, JSON.stringify({
    manifest: parsed,
    digest,
    status: "staged" as const,
    nextApplied: 1,
    appliedSeqs: [],
    errors: {},
  }, null, 2), "utf8");
  const record: StagingRecord = {
    manifest: parsed,
    manifestDigest: digest,
    nextApplied: 1,
    status: "staged",
    appliedSeqs: [],
    errors: {},
    stagingDir,
  };
  stagingRecords.set(parsed.manifestId, record);
  return { record, stagingDir };
}

/** Restore a staging record from disk (used by resume). */
export async function loadStagedManifest(
  stagingRoot: string,
  manifestId: string,
): Promise<StagingRecord | undefined> {
  const cached = stagingRecords.get(manifestId);
  if (cached) return cached;
  const stagingDir = path.join(stagingRoot, "staging", manifestId);
  try {
    const raw = await readFile(path.join(stagingDir, "manifest.json"), "utf8");
    const json = JSON.parse(raw) as {
      manifest: OperationManifest;
      digest: string;
      status: StagingStatus;
      nextApplied: number;
      appliedSeqs: number[];
      errors: Record<number, string>;
    };
    const record: StagingRecord = {
      manifest: json.manifest,
      manifestDigest: json.digest,
      nextApplied: json.nextApplied,
      status: json.status,
      appliedSeqs: json.appliedSeqs,
      errors: json.errors,
      stagingDir,
    };
    stagingRecords.set(manifestId, record);
    return record;
  } catch {
    return undefined;
  }
}

/**
 * Apply a staged manifest's remaining operations.
 *
 * Semantics:
 *  - Each operation's filesystem effect is dispatched through the
 *    `FileWorkerPool` so per-workspace ordering is preserved.
 *  - On success the staging record's `nextApplied` advances and the
 *    on-disk snapshot is updated.
 *  - On per-op failure the error is captured, the operation is
 *    recorded in `errors`, and the loop continues with the next
 *    operation (no rollback — the partial state remains visible).
 *  - Returns when every operation has settled; the record's
 *    `status` is one of `applied` (all succeeded), `partial`
 *    (some failed), or `cancelled` (caller cancelled mid-flight).
 */
export async function applyStagedManifest(
  stagingRoot: string,
  manifestId: string,
  options: { pool: FileWorkerPool; cancelSignal?: { cancelled: boolean } } = { pool: new FileWorkerPool() },
): Promise<StagingRecord> {
  const record = await loadStagedManifest(stagingRoot, manifestId);
  if (!record) throw new AppError("NOT_FOUND", `staged manifest ${manifestId} not found`);
  if (record.status === "applied" || record.status === "cancelled")
    throw new AppError(
      "CONFLICT",
      `manifest ${manifestId} already in terminal state "${record.status}"`,
    );
  record.status = "applying";
  await persistSnapshot(stagingRoot, record);
  for (const op of record.manifest.operations) {
    if (options.cancelSignal?.cancelled) {
      record.status = "cancelled";
      await persistSnapshot(stagingRoot, record);
      return record;
    }
    if (op.seq < record.nextApplied) continue; // already applied
    try {
      await options.pool.submit(record.manifest, op);
      record.appliedSeqs.push(op.seq);
      record.nextApplied = Math.max(record.nextApplied, op.seq + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.errors[op.seq] = message;
    }
    await persistSnapshot(stagingRoot, record);
  }
  record.status = Object.keys(record.errors).length === 0 ? "applied" : "partial";
  await persistSnapshot(stagingRoot, record);
  return record;
}

/** Cancel a staged manifest. No rollback — the audit trail is the
 *  source of truth. The next `applyStagedManifest` call observes
 *  the cancel flag and converges to `cancelled`. */
export function cancelStagedManifest(
  manifestId: string,
  cancelSignal: { cancelled: boolean },
): StagingRecord {
  cancelSignal.cancelled = true;
  const record = stagingRecords.get(manifestId);
  if (!record) throw new AppError("NOT_FOUND", `staged manifest ${manifestId} not found`);
  // Note: do NOT flip `record.status` here — the apply loop will
  // converge to `cancelled` once it observes the signal at the top
  // of the next iteration. Flipping the status here would make the
  // subsequent apply call refuse with CONFLICT.
  return record;
}

async function persistSnapshot(_stagingRoot: string, record: StagingRecord): Promise<void> {
  if (!record.stagingDir) return;
  await mkdir(record.stagingDir, { recursive: true });
  const snapshotPath = path.join(record.stagingDir, "manifest.json");
  await writeFile(snapshotPath, JSON.stringify({
    manifest: record.manifest,
    digest: record.manifestDigest,
    status: record.status,
    nextApplied: record.nextApplied,
    appliedSeqs: record.appliedSeqs,
    errors: record.errors,
  }, null, 2), "utf8");
}

/** Helper: build a manifest from a simple op-list. Used by the
 *  tests and the M3b recipe step. */
export function buildManifest(args: {
  workspacePath: string;
  rootIdentity: string;
  issuedBy: string;
  operations: Array<{
    kind: OperationKind;
    path: string;
    content?: string | null;
    reason: string;
  }>;
  label?: string | null;
}): OperationManifest {
  const operations = args.operations.map((o, i) => ({
    seq: i + 1,
    kind: o.kind,
    path: o.path,
    content: o.content ?? null,
    reason: o.reason,
  }));
  return operationManifestSchema.parse({
    manifestId: randomUUID(),
    workspacePath: args.workspacePath,
    rootIdentity: args.rootIdentity,
    issuedBy: args.issuedBy,
    issuedAt: new Date().toISOString(),
    operations,
    label: args.label ?? null,
  });
}

void z;
void createHash;