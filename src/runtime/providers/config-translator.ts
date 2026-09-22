/**
 * M4.5 — provider-native configuration translation.
 *
 * M4.5 says: "Keep provider-native configuration translation in
 * provider adapters; commands use explicit argv or deliberately
 * selected shell semantics." The runtime today already spawns the
 * native adapter with explicit argv (`spawn(binary, [...args])`,
 * no `shell: true`); this module makes the translation rule
 * explicit and testable so a future adapter author does not have
 * to re-derive it from `framed-runner.ts`.
 *
 * The translator is **pure**: same input ⇒ same output, no I/O,
 * no `process.env` mutation. It returns the argv tail, env
 * overrides, and working directory the caller should apply; the
 * caller (`framed-runner.ts`) decides whether to spawn.
 *
 * Defence-in-depth, not paranoia: the translator refuses to
 * forward any `envOverrides` key starting with `LD_`, `DYLD_`,
 * `NODE_`, or `PYTHON` — those prefixes are the four loader
 * families the IMPLEMENTATION-README M4 gate cites for
 * loader-injection vectors. A `providerConfig` carrying one of
 * those prefixes raises `AppError("INVALID_REQUEST", …)` so a
 * malicious or misconfigured profile cannot smuggle a loader
 * past the gate. Likewise, `binaryArgs` cannot contain shell
 * metacharacters (`; | & \` $ ( )`) — argv is opaque, never
 * quoted.
 *
 * The `shellMode` setting (`src/shared/settings.ts:24`) governs
 * the *runtime's own shell* (PTY attachment, command-runner); it
 * does **not** influence provider-adapter argv. The provider
 * surface is always explicit-argv.
 */
import { z } from "zod";
import { ZodError } from "zod";
import { AppError } from "../../shared/errors";

/**
 * Provider-specific configuration the orchestrator hands to the
 * adapter. The shape is `.strict()` so unknown keys raise at
 * parse time — a typo in a profile cannot silently land on the
 * wire.
 */
export const providerConfigSchema = z
  .object({
    /**
     * Extra argv tokens appended **after** the provider's fixed
     * translation (`--provider-version`, `--model`, …). The
     * caller is responsible for any flag semantics the provider
     * supports; the translator passes them through verbatim.
     */
    binaryArgs: z.array(z.string().min(1).max(1024)).max(64).default([]),
    /**
     * Environment overrides merged on top of `process.env` for
     * the child. Keys matching `/^(LD_|DYLD_|NODE_|PYTHON)/` are
     * rejected — those prefixes are the loader-injection vectors
     * cited in the M4 gate.
     */
    envOverrides: z.record(z.string(), z.string()).default({}),
    /** Working directory for the child (`null` = inherit cwd). */
    workingDirectory: z.string().min(1).max(1024).nullable().default(null),
  })
  .strict();

export type ProviderConfig = z.infer<typeof providerConfigSchema>;

export interface TranslateRequest {
  readonly provider: "claude" | "codex";
  readonly providerVersion: string;
  readonly model: string;
  readonly accountMode: "anonymous" | "authenticated" | "trusted-host";
  readonly config: ProviderConfig;
}

export interface TranslateResult {
  /** Tail appended after the fixed frame-wiring flags. */
  readonly argv: readonly string[];
  /**
   * Env merged on top of `process.env` for the child. The caller
   * decides whether to apply it; the translator returns what it
   * would apply so tests can assert it without spawning.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved working directory (or `null` to inherit). */
  readonly cwd: string | null;
}

/** Forbidden env prefixes (loader-injection vectors). */
const FORBIDDEN_ENV_PREFIXES = [/^LD_/, /^DYLD_/, /^NODE_/, /^PYTHON/];

/** Shell metacharacters that must not appear in opaque argv. */
const SHELL_METACHAR_PATTERN = /[;|`$&()]/;

/**
 * Translate a `ProviderConfig` into argv tail + env overrides +
 * cwd. Pure: same input ⇒ same output, no I/O.
 *
 * Per-provider argv shape:
 *  - **claude** — `--provider-version <v> --model <m>
 *    --account-mode <a> [...config.binaryArgs]`.
 *  - **codex** — `--version <v> --model <m> [...config.binaryArgs]`
 *    (the M4.1 codex stub parses `--version`, not
 *    `--provider-version`).
 *
 * Throws `AppError("INVALID_REQUEST", …)` when:
 *  - `config` fails schema validation (unknown keys, wrong shape).
 *  - Any `binaryArgs` entry contains a shell metacharacter.
 *  - Any `envOverrides` key matches a forbidden prefix.
 */
export function translateProviderConfig(req: TranslateRequest): TranslateResult {
  // The schema's `.strict()` already rejects unknown keys; we
  // surface the error as `INVALID_REQUEST` so the IPC boundary
  // translates it consistently with the rest of the runtime.
  let config: ProviderConfig;
  try {
    config = providerConfigSchema.parse(req.config);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new AppError(
        "INVALID_REQUEST",
        `Provider config failed schema validation: ${error.issues.map((i) => i.message).join("; ")}`,
      );
    }
    throw error;
  }

  if (req.providerVersion.length === 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "Provider config translation requires a non-empty providerVersion",
    );
  }
  if (req.model.length === 0) {
    throw new AppError(
      "INVALID_REQUEST",
      "Provider config translation requires a non-empty model",
    );
  }

  // Shell-metachar blocklist: argv is opaque. Anything that
  // would change meaning under shell parsing is forbidden.
  for (const [i, arg] of config.binaryArgs.entries()) {
    if (SHELL_METACHAR_PATTERN.test(arg)) {
      throw new AppError(
        "INVALID_REQUEST",
        `Provider config binaryArgs[${i}] contains a shell metacharacter; argv is opaque and cannot be quoted: "${arg}"`,
      );
    }
  }

  // Loader-injection blocklist: refuse keys that would let a
  // config override the runtime's own loader environment.
  for (const key of Object.keys(config.envOverrides)) {
    if (FORBIDDEN_ENV_PREFIXES.some((re) => re.test(key))) {
      throw new AppError(
        "INVALID_REQUEST",
        `Provider config envOverrides.${key} is forbidden (loader-injection vector); refused`,
      );
    }
  }

  // Per-provider fixed argv head.
  const head: string[] =
    req.provider === "claude"
      ? [
          "--provider-version",
          req.providerVersion,
          "--model",
          req.model,
          "--account-mode",
          req.accountMode,
        ]
      : ["--version", req.providerVersion, "--model", req.model];

  return Object.freeze({
    argv: Object.freeze([...head, ...config.binaryArgs]),
    env: Object.freeze({ ...config.envOverrides }),
    cwd: config.workingDirectory,
  });
}
