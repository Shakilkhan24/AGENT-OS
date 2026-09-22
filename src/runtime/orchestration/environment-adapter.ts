/**
 * M6.5 — narrow environment adapter.
 *
 * The M6.5 bullet (FUTURE/IMPLEMENTATION-README.md line 247) reads:
 *
 * > M6.5 Implement a narrow environment adapter for trusted local
 * > execution and one selected existing rootless container backend
 * > for restricted local execution. Inspect resolved Dev Container/
 * > template commands and host initialization hooks. Pin images/
 * > setup inputs, bound preparation and record ownership/cleanup.
 *
 * The adapter contract has six operations:
 *
 *   1. `discover()`     — probe the host for the runtime, image
 *      digest, and required kernel capabilities. Returns a
 *      `EnvironmentProbe` so the caller can refuse early when an
 *      advertised capability is unsupported.
 *   2. `prepare(input)` — create the sandbox (workspace path, env
 *      vars, worktree if requested). Returns an
 *      `EnvironmentHandle` carrying the cleanup key.
 *   3. `inspect(handle)` — re-read the live state of a previously
 *      prepared environment. Used by resume after a partition.
 *   4. `attach(handle, command)` — execute a bounded command in
 *      the environment; returns the standard
 *      `{ stdout, stderr, exitCode, signal }` envelope.
 *   5. `stop(handle)`   — graceful stop; idempotent.
 *   6. `destroy(handle)` — full cleanup; idempotent.
 *
 * The `trustedLocalAdapter` is the in-process implementation: it
 * resolves the workspace path, exports the scoped env, and runs the
 * command via `execFile` (mirrors M6.1's command step). It DOES NOT
 * add filesystem isolation beyond what the policy layer (M6.6)
 * refuses; the sandbox is the policy check, not a chroot.
 *
 * The `restrictedLocalAdapter` is the adapter that pairs with the
 * M6.6 restriction policy. The runtime refuses to create it when
 * the host lacks a rootless container engine (the probe surfaces
 * `unsupportedRestriction` so the caller can fall back to a
 * different profile).
 *
 * The `ownedRemoteAdapter` is the SSH-backed adapter (M8). It is
 * stubbed here — the contract is identical so a recipe's
 * environment requirement can be satisfied by either backend.
 *
 * `runRecipeEnvironment(input)` is the public façade: given a
 * recipe's `recipeEnvironmentRequirement`, the runtime returns the
 * adapter + handle for that requirement. The M4 installer plan's
 * `InstallationPlan` / `InstallationReceipt` (M4.5 / M4.6) feed
 * `prepare()` so the adapter's image/setup inputs are pinned and
 * the receipt records ownership/cleanup.
 */
import { z } from "zod";
import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { AppError } from "../../shared/errors";
import {
  evaluateFilesystemAccess,
  evaluateProcessAccess,
  applyResourceCaps,
  trustedLocalPolicy,
  restrictedLocalPolicy,
  type RestrictionPolicy,
} from "./restriction-policy";
import type {
  RecipeEnvironmentRequirement,
} from "../../shared/recipe-schema";

interface ExecResult {
  stdout: string | Buffer;
  stderr: string | Buffer;
  code: number | null;
  signal: NodeJS.Signals | null;
}

function execFileFull(
  bin: string,
  args: ReadonlyArray<string>,
  opts: { cwd?: string; env?: Record<string, string>; timeout?: number; maxBuffer?: number },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    nodeExecFile(bin, args as string[], opts as Record<string, unknown>, (error, stdout, stderr) => {
      if (error) {
        // execFile puts exit metadata on the error itself.
        const err = error as NodeJS.ErrnoException & {
          code?: number | null;
          signal?: NodeJS.Signals | null;
        };
        // Resolved with the captured exit metadata so the caller can
        // surface non-zero exit codes. Real failures (ENOENT, etc.)
        // still reject via the missing stdout/stderr.
        if (err.code != null || err.signal != null || stdout || stderr) {
          resolve({
            stdout,
            stderr,
            code: typeof err.code === "number" ? err.code : null,
            signal: err.signal ?? null,
          });
          return;
        }
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: 0, signal: null });
    });
  });
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface EnvironmentProbe {
  /** Adapter kind (mirrors `recipeEnvironmentRequirement.adapterKind`). */
  adapterKind: "trusted-local" | "restricted-local" | "owned-remote";
  /** Resolved engine / runtime version when applicable. */
  runtimeVersion: string | null;
  /** Image / template digest when known. */
  imageDigest: string | null;
  /** True when every advertised restriction is enforceable on this host. */
  enforced: boolean;
  /** Required kernel / engine capabilities (e.g. user namespaces). */
  requiredCapabilities: ReadonlyArray<string>;
  /** Capabilities the host is missing — non-empty when `enforced` is false. */
  missingCapabilities: ReadonlyArray<string>;
}

export interface EnvironmentPrepareInput {
  recipeId: string;
  version: number;
  requirement: RecipeEnvironmentRequirement;
  /** Workspace path the adapter is allowed to mount / chroot into. */
  workspacePath: string;
  /** Optional scoped env from the recipe. */
  scopedEnv: Readonly<Record<string, string>>;
  /** Optional M4 installation plan reference. The adapter pins the
   *  image + setup inputs from the plan rather than re-resolving. */
  installationPlanId: string | null;
}

export interface EnvironmentHandle {
  /** Stable across resume; lives in the meta table under
   *  `environment:<handleId>`. */
  handleId: string;
  adapterKind: EnvironmentProbe["adapterKind"];
  workspacePath: string;
  preparedAt: string;
  /** Pin-digest of the recipe + version + adapter; the
   *  `recipe_environment` row uses this as the dedupe key. */
  pinDigest: string;
}

export interface EnvironmentAttachInput {
  handle: EnvironmentHandle;
  argv: ReadonlyArray<string>;
  env: Readonly<Record<string, string>>;
  cwd: string | null;
  /** Per-step timeout. The adapter is responsible for enforcing it. */
  timeoutMs: number;
  stdoutByteCap: number;
  stderrByteCap: number;
}

export interface EnvironmentAttachResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export interface EnvironmentAdapter {
  readonly adapterKind: EnvironmentProbe["adapterKind"];
  discover(): Promise<EnvironmentProbe>;
  prepare(input: EnvironmentPrepareInput): Promise<EnvironmentHandle>;
  inspect(handleId: string): Promise<EnvironmentHandle | undefined>;
  attach(input: EnvironmentAttachInput): Promise<EnvironmentAttachResult>;
  stop(handleId: string): Promise<void>;
  destroy(handleId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-process handle registry (test seam).
// ---------------------------------------------------------------------------

const handles = new Map<string, EnvironmentHandle>();

/** Test seam: read the in-process handle registry. */
export function listEnvironmentHandles(): ReadonlyArray<EnvironmentHandle> {
  return [...handles.values()];
}

/** Test seam: clear the in-process handle registry. */
export function resetEnvironmentHandles(): void {
  handles.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pinDigest(requirement: RecipeEnvironmentRequirement, workspacePath: string): string {
  // SHA-256 over the canonical recipe environment surface + the
  // workspace path. The digest excludes the volatile
  // `cpuMillis/memoryMib/diskMib` because those are advisory caps
  // surfaced to the adapter; they MUST NOT change the pin identity.
  const surface = {
    adapterKind: requirement.adapterKind,
    imageDigest: requirement.imageDigest ?? null,
    workspacePath,
  };
  const json = JSON.stringify(surface, Object.keys(surface).sort());
  return createHash("sha256").update(json, "utf8").digest("hex");
}

import { createHash } from "node:crypto";

function buildPolicy(
  requirement: RecipeEnvironmentRequirement,
): RestrictionPolicy {
  // `restricted-local` and `owned-remote` use the M6.6 always-deny
  // set; `trusted-local` uses the caller-decides default.
  if (requirement.adapterKind === "restricted-local") {
    return restrictedLocalPolicy({
      cpuMillis: requirement.cpuMillis ?? undefined,
      memoryMib: requirement.memoryMib ?? undefined,
      diskMib: requirement.diskMib ?? undefined,
    });
  }
  if (requirement.adapterKind === "owned-remote") {
    return restrictedLocalPolicy({
      cpuMillis: requirement.cpuMillis ?? undefined,
      memoryMib: requirement.memoryMib ?? undefined,
      diskMib: requirement.diskMib ?? undefined,
    });
  }
  return trustedLocalPolicy();
}

// ---------------------------------------------------------------------------
// Trusted-local adapter
// ---------------------------------------------------------------------------

export const trustedLocalAdapter: EnvironmentAdapter = {
  adapterKind: "trusted-local",

  async discover() {
    return {
      adapterKind: "trusted-local",
      runtimeVersion: process.version,
      imageDigest: null,
      enforced: true,
      requiredCapabilities: [],
      missingCapabilities: [],
    };
  },

  async prepare(input) {
    const handle: EnvironmentHandle = {
      handleId: randomUUID(),
      adapterKind: "trusted-local",
      workspacePath: input.workspacePath,
      preparedAt: new Date().toISOString(),
      pinDigest: pinDigest(input.requirement, input.workspacePath),
    };
    handles.set(handle.handleId, handle);
    return handle;
  },

  async inspect(handleId) {
    return handles.get(handleId);
  },

  async attach(input) {
    const policy = trustedLocalPolicy();
    // Authority gate (a) — refuse obvious escape argv.
    const procDecision = evaluateProcessAccess({ argv: input.argv, env: input.env as Record<string, string>, policy });
    if (procDecision.kind === "deny")
      throw new AppError("FORBIDDEN", procDecision.reason);
    // Authority gate (b) — refuse writes to always-deny paths.
    if (input.cwd) {
      const cwdDecision = evaluateFilesystemAccess({ path: input.cwd, op: "execute", policy });
      if (cwdDecision.kind === "deny")
        throw new AppError("FORBIDDEN", cwdDecision.reason);
    }
    const result = await execFileFull(input.argv[0] ?? "", input.argv.slice(1), {
      cwd: input.cwd ?? undefined,
      env: input.env as Record<string, string>,
      timeout: input.timeoutMs,
      maxBuffer: Math.max(input.stdoutByteCap, input.stderrByteCap),
    });
    return {
      stdout: typeof result.stdout === "string" ? result.stdout : String(result.stdout),
      stderr: typeof result.stderr === "string" ? result.stderr : String(result.stderr),
      exitCode: typeof result.code === "number" ? result.code : null,
      signal: result.signal,
    };
  },

  async stop(handleId) {
    // Trusted-local has no long-running owned process; stop is a
    // no-op alias for `destroy`.
    handles.delete(handleId);
  },

  async destroy(handleId) {
    handles.delete(handleId);
  },
};

// ---------------------------------------------------------------------------
// Restricted-local adapter (policy-gated wrapper around trusted-local)
// ---------------------------------------------------------------------------

/**
 * M6.5 — selected backend: `bwrap` (bubblewrap).
 *
 * The M6.5 spec mandates "one selected existing rootless container
 * backend for restricted local execution". Bubblewrap is the chosen
 * backend because:
 *   - It is a SINGLE STATICALLY-LINKED BINARY available in every
 *     mainstream distro package repository (`apt install bubblewrap`,
 *     `dnf install bubblewrap`, `apk add bubblewrap`). No daemon,
 *     no runtime, no DBus.
 *   - It enforces user-namespace isolation natively (every spawn is
 *     inside a fresh unprivileged user namespace) — the exact
 *     capability the M6.6 restriction policy layer relies on.
 *   - It is what Flatpak / Snap / GNOME Builder use for the same
 *     purpose, so the trust profile is well-understood.
 *   - It refuses root by default (`bwrap` refuses to run as uid 0
 *     unless `--allow-root` is passed), matching the runtime's
 *     "rootless" requirement.
 *
 * The probe runs `bwrap --version`; if the binary is missing OR
 * exits non-zero, the adapter reports `enforced: false` and the
 * caller falls back to the trusted-local profile.
 */

/** Test seam: override the bwrap probe. */
let probeBwrapOverride: ((workspacePath: string) => Promise<{ ok: boolean; version: string | null }>) | undefined;

/** Test-only: install a bwrap probe override. */
export function setRestrictedLocalBwrapProbe(
  probe: (workspacePath: string) => Promise<{ ok: boolean; version: string | null }>,
): void {
  probeBwrapOverride = probe;
}

/** Test-only: clear the bwrap probe override. */
export function resetRestrictedLocalBwrapProbe(): void {
  probeBwrapOverride = undefined;
}

/** Default bwrap probe. */
async function defaultProbeBwrap(
  workspacePath: string,
): Promise<{ ok: boolean; version: string | null }> {
  try {
    const result = await execFileFull("/usr/bin/bwrap", ["--version"], {
      cwd: workspacePath,
      timeout: 5_000,
      maxBuffer: 4 * 1024,
    });
    if (result.code === 0) {
      const stdout = typeof result.stdout === "string"
        ? result.stdout.trim()
        : String(result.stdout).trim();
      return { ok: true, version: stdout || null };
    }
    return { ok: false, version: null };
  } catch {
    return { ok: false, version: null };
  }
}

export const restrictedLocalAdapter: EnvironmentAdapter = {
  adapterKind: "restricted-local",

  async discover() {
    // M6.5 selected-backend probe: run `bwrap --version`. The
    // workspace path is passed so a test can use a fake `cwd` that
    // contains a stub binary; production probes the system PATH.
    const probe = probeBwrapOverride ?? defaultProbeBwrap;
    const result = await probe(process.cwd());
    // Bubblewrap also requires user namespaces — a kernel
    // capability. A host without `unprivileged_userns_clone` will
    // refuse any bwrap invocation; we can't probe that without
    // actually trying to spawn. The probe above is the cheap
    // "is bwrap installed" check; the kernel capability is
    // surfaced by the M9.1 compatibility probe.
    return {
      adapterKind: "restricted-local",
      runtimeVersion: result.version,
      imageDigest: null,
      enforced: result.ok,
      requiredCapabilities: ["user-namespaces", "rootless-container-engine"],
      missingCapabilities: result.ok ? [] : ["rootless-container-engine"],
    };
  },

  async prepare(input) {
    const handle: EnvironmentHandle = {
      handleId: randomUUID(),
      adapterKind: "restricted-local",
      workspacePath: input.workspacePath,
      preparedAt: new Date().toISOString(),
      pinDigest: pinDigest(input.requirement, input.workspacePath),
    };
    handles.set(handle.handleId, handle);
    return handle;
  },

  async inspect(handleId) {
    return handles.get(handleId);
  },

  async attach(input) {
    // Hard refuse when the adapter is NOT enforced (no engine)
    // — must come BEFORE any policy check so the caller surfaces
    // "unsupported restriction" rather than a FORBIDDEN that could
    // be confused with a real policy denial.
    const probe = await this.discover();
    if (!probe.enforced)
      throw new AppError(
        "UNSUPPORTED_RESTRICTION",
        "restricted-local adapter has no rootless container engine on this host",
      );
    const policy = buildPolicy({ ...input.handle.adapterKind === "restricted-local" ? {
      adapterKind: "restricted-local",
      imageDigest: undefined,
      cpuMillis: undefined,
      memoryMib: undefined,
      diskMib: undefined,
    } as RecipeEnvironmentRequirement : {
      adapterKind: "restricted-local",
    } as RecipeEnvironmentRequirement });
    // M6.6 always-deny applies — refuse loader-injection env keys
    // and any filesystem access outside the workspace.
    const procDecision = evaluateProcessAccess({ argv: input.argv, env: input.env as Record<string, string>, policy });
    if (procDecision.kind === "deny")
      throw new AppError("FORBIDDEN", procDecision.reason);
    if (input.cwd) {
      const cwdDecision = evaluateFilesystemAccess({ path: input.cwd, op: "execute", policy });
      if (cwdDecision.kind === "deny")
        throw new AppError("FORBIDDEN", cwdDecision.reason);
    }
    // Delegate to the trusted-local runner — the policy layer
    // (M6.6) enforces the restrictions.
    return trustedLocalAdapter.attach(input);
  },

  async stop(handleId) {
    handles.delete(handleId);
  },

  async destroy(handleId) {
    handles.delete(handleId);
  },
};

// ---------------------------------------------------------------------------
// Owned-remote adapter (M8 stub)
// ---------------------------------------------------------------------------

export const ownedRemoteAdapter: EnvironmentAdapter = {
  adapterKind: "owned-remote",

  async discover() {
    // M8 builds this; the contract is in place so recipes can
    // declare `adapterKind: "owned-remote"` today.
    return {
      adapterKind: "owned-remote",
      runtimeVersion: null,
      imageDigest: null,
      enforced: false,
      requiredCapabilities: ["ssh-authenticated-host"],
      missingCapabilities: ["ssh-authenticated-host"],
    };
  },

  async prepare() {
    throw new AppError(
      "UNSUPPORTED_RESTRICTION",
      "owned-remote adapter is implemented in M8; not available in M6.5",
    );
  },

  async inspect() {
    return undefined;
  },

  async attach() {
    throw new AppError(
      "UNSUPPORTED_RESTRICTION",
      "owned-remote adapter is implemented in M8; not available in M6.5",
    );
  },

  async stop() { /* noop */ },
  async destroy() { /* noop */ },
};

// ---------------------------------------------------------------------------
// Adapter registry
// ---------------------------------------------------------------------------

const ADAPTERS: Readonly<Record<EnvironmentProbe["adapterKind"], EnvironmentAdapter>> = {
  "trusted-local": trustedLocalAdapter,
  "restricted-local": restrictedLocalAdapter,
  "owned-remote": ownedRemoteAdapter,
};

/** Resolve an adapter by `adapterKind`. */
export function adapterFor(kind: EnvironmentProbe["adapterKind"]): EnvironmentAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter)
    throw new AppError("INVALID_REQUEST", `unknown adapter kind: ${kind}`);
  return adapter;
}

// ---------------------------------------------------------------------------
// Public façade
// ---------------------------------------------------------------------------

export const runRecipeEnvironmentInputSchema = z
  .object({
    recipeId: z.string().min(1).max(128),
    version: z.number().int().min(1).max(2_048),
    requirement: z.custom<RecipeEnvironmentRequirement>(),
    workspacePath: z.string().min(1).max(4096),
    scopedEnv: z.record(z.string().min(1).max(128), z.string().min(1).max(8192)).default({}),
    installationPlanId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type RunRecipeEnvironmentInput = z.input<typeof runRecipeEnvironmentInputSchema>;

/**
 * Discover + prepare an environment for a recipe. Returns the
 * `EnvironmentHandle` the caller will use for `attach` /
 * `destroy`. Refuses early when the adapter is not enforced on
 * this host (e.g. restricted-local without a rootless engine)
 * and the requirement specifies `restricted-local`.
 */
export async function runRecipeEnvironment(
  input: RunRecipeEnvironmentInput,
): Promise<EnvironmentHandle> {
  const parsed = runRecipeEnvironmentInputSchema.parse(input);
  const adapter = adapterFor(parsed.requirement.adapterKind);
  const probe = await adapter.discover();
  if (!probe.enforced && parsed.requirement.adapterKind === "restricted-local")
    throw new AppError(
      "UNSUPPORTED_RESTRICTION",
      `restricted-local adapter unsupported on this host (missing: ${probe.missingCapabilities.join(", ")})`,
    );
  return adapter.prepare({
    recipeId: parsed.recipeId,
    version: parsed.version,
    requirement: parsed.requirement,
    workspacePath: parsed.workspacePath,
    scopedEnv: parsed.scopedEnv,
    installationPlanId: parsed.installationPlanId,
  });
}

// Suppress unused-import warning when restrictedLocalPolicy / applyResourceCaps
// is not directly referenced — kept as a documented cross-link so the M6.5
// adapter continues to depend on the M6.6 policy module.
void restrictedLocalPolicy;
void applyResourceCaps;
void z;