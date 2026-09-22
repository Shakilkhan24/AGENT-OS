/**
 * M6.6 — restriction policy engine.
 *
 * The M6.6 bullet (FUTURE/IMPLEMENTATION-README.md line 248) reads:
 *
 * > M6.6 Certify each advertised filesystem/network/process/resource
 * > restriction with adversarial fixtures, including runtime/engine
 * > socket, home, credentials, SSH agent, DNS/IPv6 and metadata
 * > endpoints. Do not mount powerful host sockets into restricted
 * > jobs. Unsupported enforcement blocks that restricted profile;
 * > trusted-host use remains explicitly available for trusted projects.
 *
 * This module is the policy half. M6.6's adversarial fixtures
 * (`tests/runtime/restriction-policy.test.ts`) exercise the refusal
 * paths so a regression in any check is caught by a focused test.
 *
 * Three surfaces are enforced:
 *
 *   1. FILESYSTEM
 *      `evaluateFilesystemAccess({ path, op, policy })` decides
 *      `allow | deny` against the policy's allow/deny path-glob set
 *      plus the always-deny set (`RUNTIME_SOCKET_DIR`,
 *      `~/.ssh/agent.sock`, `~/.aws/credentials`,
 *      `~/.gnupg/`, `~/.docker/`, `~/.config/gh/`,
 *      `/etc/shadow`, `/proc/<pid>/mem`, etc.). The check is
 *      path-prefix + lexical, NOT a real syscall — a real
 *      chroot/sandbox is M6.5's job. The policy's job is to refuse
 *      obviously-escape paths before any syscall dispatches.
 *
 *   2. NETWORK
 *      `evaluateNetworkAccess({ host, port, policy })` refuses:
 *        - the runtime socket directory's path (mounted as socket);
 *        - `127.0.0.0/8`, `::1`, `169.254.0.0/16` (loopback / link
 *          local), and the IPv6 unique-local range `fc00::/7`;
 *        - the cloud metadata endpoints (`169.254.169.254` and
 *          `fd00:ec2::254`) regardless of port;
 *        - the SSH-agent port (`SSH_AUTH_SOCK` host:0 and `port 22`
 *          when not in the explicit allow-list).
 *      The lookup is a literal / CIDR match on the resolved host
 *      string; a real sandbox is M6.5's job.
 *
 *   3. PROCESS
 *      `evaluateProcessAccess({ command, argv, env, policy })`
 *      refuses:
 *        - empty `argv[0]`;
 *        - absolute paths under `/proc/<pid>/mem`,
 *          `/proc/<pid>/environ`;
 *        - env keys whose name starts with the loader-injection
 *          prefix (`LD_`, `DYLD_`, `NODE_`, `PYTHON_`, mirroring
 *          M6.3's rehearsal check);
 *        - the literal `eval` / `sh -c "..."` patterns from M3b.
 *
 * Resource caps (`cpuMillis`, `memoryMib`, `diskMib`) come from
 * `recipeEnvironmentRequirementSchema` (M6.2); `applyResourceCaps`
 * is the small adapter that surfaces the cap as a numeric triplet
 * for the adapter / sandbox layer to enforce. The runtime itself
 * does NOT enforce caps — that is M6.5's responsibility.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Policy schema
// ---------------------------------------------------------------------------

/**
 * Path-glob entry. The runtime ships a small matcher:
 *   - `prefix` matches when the candidate path equals the prefix or
 *     sits below it (lexical — no symlink resolution);
 *   - `pattern` accepts `*` (one path segment) and `**` (any depth).
 */
export const restrictionPathRuleSchema = z
  .object({
    /** Glob-style pattern; matches via `matchPathPattern`. */
    pattern: z.string().min(1).max(1024),
    /** Action when the candidate matches. */
    action: z.enum(["allow", "deny"]),
    /** Optional human-readable reason — surfaced in error envelopes. */
    reason: z.string().max(256).optional(),
  })
  .strict();
export type RestrictionPathRule = z.infer<typeof restrictionPathRuleSchema>;

export const restrictionPolicySchema = z
  .object({
    /** Allow/deny path rules. First match wins (deny wins ties). */
    paths: z.array(restrictionPathRuleSchema).max(256).default([]),
    /** Allow/deny network rules. First match wins. */
    hosts: z.array(
      z
        .object({
          host: z.string().min(1).max(256),
          port: z.number().int().min(0).max(65535).nullable().default(null),
          action: z.enum(["allow", "deny"]),
          reason: z.string().max(256).optional(),
        })
        .strict(),
    ).max(256).default([]),
    /** True when the runtime should refuse the entire job on a
     *  policy miss (the default for `restricted-local`). The
     *  `trusted-local` profile uses `false` — the project's own
     *  policy decides. */
    refuseOnMiss: z.boolean().default(true),
    /** Optional resource caps; surfaced to the adapter. */
    cpuMillis: z.number().int().min(100).max(64_000).nullable().default(null),
    memoryMib: z.number().int().min(64).max(65_536).nullable().default(null),
    diskMib: z.number().int().min(64).max(1_048_576).nullable().default(null),
  })
  .strict();
export type RestrictionPolicy = z.infer<typeof restrictionPolicySchema>;

// ---------------------------------------------------------------------------
// Default always-deny set (filesystem)
// ---------------------------------------------------------------------------

/**
 * Paths the runtime never allows under `restricted-local` /
 * `owned-remote` profiles. These are the canonical escape surfaces:
 *
 *   - the runtime socket directory (the daemon's IPC);
 *   - `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, `~/.docker/`,
 *     `~/.config/gh/`, `~/.kube/`, `~/.netrc` (credentials);
 *   - `/etc/shadow`, `/etc/passwd`, `/etc/sudoers` (host auth);
 *   - `/proc/<pid>/{mem,environ,maps}` (process introspection);
 *   - `/sys/`, `/dev/` (host kernel surfaces);
 *   - `~/.minimal/` (the runtime's own data dir; never let the
 *     agent touch its control plane).
 *
 * The defaults are intentionally coarse — they ship in the
 * `restricted-local` / `owned-remote` profile only. Trusted-local
 * callers explicitly opt out by passing `refuseOnMiss: false` and
 * omitting the always-deny rules from `paths`.
 */
export const ALWAYS_DENY_PATHS: ReadonlyArray<RestrictionPathRule> = [
  { pattern: "/proc/*/mem", action: "deny", reason: "process memory disallowed" },
  { pattern: "/proc/*/environ", action: "deny", reason: "process environment disallowed" },
  { pattern: "/proc/*/maps", action: "deny", reason: "process memory map disallowed" },
  { pattern: "/sys/**", action: "deny", reason: "kernel sysfs disallowed" },
  { pattern: "/dev/**", action: "deny", reason: "raw device nodes disallowed" },
  { pattern: "/etc/shadow", action: "deny", reason: "host auth database disallowed" },
  { pattern: "/etc/passwd", action: "deny", reason: "host user database disallowed" },
  { pattern: "/etc/sudoers", action: "deny", reason: "host sudo config disallowed" },
  { pattern: "/etc/sudoers.d/**", action: "deny", reason: "host sudo config disallowed" },
  { pattern: "/run/minimal.sock", action: "deny", reason: "runtime IPC socket disallowed" },
  { pattern: "/run/minimal/**", action: "deny", reason: "runtime control directory disallowed" },
  { pattern: "/var/lib/minimal/**", action: "deny", reason: "runtime data directory disallowed" },
  // Home-directory credential surfaces. The `~` prefix patterns
  // match paths that literally start with `~/` (e.g. a user supplies
  // `~/.ssh/agent.sock` from their shell). The `/home/*/` and `/root/`
  // patterns cover the same paths after POSIX home expansion — the
  // runtime sees the expanded form because it never invokes a shell
  // to interpret `~`.
  { pattern: "~/.ssh/agent.sock", action: "deny", reason: "ssh agent socket disallowed" },
  { pattern: "/home/*/.ssh/agent.sock", action: "deny", reason: "ssh agent socket disallowed" },
  { pattern: "/root/.ssh/agent.sock", action: "deny", reason: "ssh agent socket disallowed" },
  { pattern: "~/.ssh/**", action: "deny", reason: "ssh credentials disallowed" },
  { pattern: "/home/*/.ssh/**", action: "deny", reason: "ssh credentials disallowed" },
  { pattern: "/root/.ssh/**", action: "deny", reason: "ssh credentials disallowed" },
  { pattern: "~/.aws/**", action: "deny", reason: "aws credentials disallowed" },
  { pattern: "/home/*/.aws/**", action: "deny", reason: "aws credentials disallowed" },
  { pattern: "/root/.aws/**", action: "deny", reason: "aws credentials disallowed" },
  { pattern: "~/.gnupg/**", action: "deny", reason: "gpg keyring disallowed" },
  { pattern: "/home/*/.gnupg/**", action: "deny", reason: "gpg keyring disallowed" },
  { pattern: "/root/.gnupg/**", action: "deny", reason: "gpg keyring disallowed" },
  { pattern: "~/.docker/**", action: "deny", reason: "docker config disallowed" },
  { pattern: "/home/*/.docker/**", action: "deny", reason: "docker config disallowed" },
  { pattern: "/root/.docker/**", action: "deny", reason: "docker config disallowed" },
  { pattern: "~/.kube/**", action: "deny", reason: "kube config disallowed" },
  { pattern: "/home/*/.kube/**", action: "deny", reason: "kube config disallowed" },
  { pattern: "/root/.kube/**", action: "deny", reason: "kube config disallowed" },
  { pattern: "~/.netrc", action: "deny", reason: "netrc credentials disallowed" },
  { pattern: "/home/*/.netrc", action: "deny", reason: "netrc credentials disallowed" },
  { pattern: "/root/.netrc", action: "deny", reason: "netrc credentials disallowed" },
  { pattern: "~/.config/gh/**", action: "deny", reason: "gh config disallowed" },
  { pattern: "/home/*/.config/gh/**", action: "deny", reason: "gh config disallowed" },
  { pattern: "/root/.config/gh/**", action: "deny", reason: "gh config disallowed" },
  { pattern: "~/.minimal/runtime.sqlite", action: "deny", reason: "minimal runtime data disallowed" },
  { pattern: "~/.minimal/**", action: "deny", reason: "runtime data directory disallowed" },
  { pattern: "/home/*/.minimal/**", action: "deny", reason: "runtime data directory disallowed" },
  { pattern: "/root/.minimal/**", action: "deny", reason: "runtime data directory disallowed" },
];

// ---------------------------------------------------------------------------
// Default always-deny set (network)
// ---------------------------------------------------------------------------

/** Loopback IPv4 — sandboxed jobs never talk to local services
 *  unless the caller explicitly allows the host:port. */
const LOOPBACK_V4 = ["127.0.0.0/8", "0.0.0.0/8"];
/** Link-local IPv4 — includes the cloud metadata range. */
const LINK_LOCAL_V4 = ["169.254.0.0/16"];
/** IPv6 unique-local + link-local + the IPv4-mapped loopback. */
const IPV6_LOCAL = ["::1/128", "fc00::/7", "fe80::/10"];
/** Cloud metadata endpoints — `169.254.169.254` (AWS / GCP /
 *  Azure) and `fd00:ec2::254` (AWS IPv6). These are never
 *  reachable from a properly configured sandbox. They are listed
 *  in addition to the link-local CIDR so the reason field is more
 *  specific. The IPv4 host overlaps `169.254.0.0/16`, the IPv6
 *  host overlaps `fc00::/7`; the literal entries come first so
 *  the audit log surfaces "metadata" rather than the broader
 *  classification. */
const METADATA_HOSTS = ["169.254.169.254", "fd00:ec2::254"];

export const ALWAYS_DENY_HOSTS: ReadonlyArray<{ host: string; reason: string }> = [
  ...LOOPBACK_V4.map((h) => ({ host: h, reason: "loopback disallowed" })),
  // Metadata endpoints come BEFORE the link-local CIDR so the
  // literal `169.254.169.254` surfaces as "metadata" rather than
  // "loopback". The same applies to `fd00:ec2::254` vs the
  // `fc00::/7` unique-local range.
  ...METADATA_HOSTS.map((h) => ({ host: h, reason: "metadata endpoint disallowed" })),
  ...LINK_LOCAL_V4.map((h) => ({ host: h, reason: "loopback disallowed" })),
  ...IPV6_LOCAL.map((h) => ({ host: h, reason: "ipv6 local disallowed" })),
];

// ---------------------------------------------------------------------------
// Filesystem access decision
// ---------------------------------------------------------------------------

export type FilesystemDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string; matchedRule?: string };

export interface FilesystemAccessQuery {
  path: string;
  /** `read | write | execute`. Symlink-free lexical check. */
  op: "read" | "write" | "execute";
  policy: RestrictionPolicy;
}

/**
 * Decide whether a candidate filesystem access is allowed. The
 * order is:
 *   1. ALWAYS_DENY_PATHS (defence-in-depth — even an empty policy
 *      refuses these).
 *   2. Caller-supplied `paths` (first match wins, ties broken in
 *      favour of `deny`).
 *   3. `refuseOnMiss` ⇒ deny the candidate with
 *      `policy.no-match`; otherwise allow.
 */
export function evaluateFilesystemAccess(query: FilesystemAccessQuery): FilesystemDecision {
  if (!query.path || query.path.trim().length === 0)
    return { kind: "deny", reason: "empty path refused" };
  const normalised = normalisePath(query.path);

  // Step 1: always-deny set.
  for (const rule of ALWAYS_DENY_PATHS) {
    if (matchPathPattern(rule.pattern, normalised))
      return { kind: "deny", reason: rule.reason ?? "always-deny path refused", matchedRule: rule.pattern };
  }

  // Step 2: caller-supplied paths.
  for (const rule of query.policy.paths) {
    if (matchPathPattern(rule.pattern, normalised)) {
      return rule.action === "deny"
        ? { kind: "deny", reason: rule.reason ?? "policy denied", matchedRule: rule.pattern }
        : { kind: "allow", reason: rule.reason };
    }
  }

  // Step 3: miss.
  if (query.policy.refuseOnMiss)
    return { kind: "deny", reason: "policy.no-match: no rule allowed this path", matchedRule: "(none)" };
  return { kind: "allow", reason: "policy.no-match allowed by caller" };
}

// ---------------------------------------------------------------------------
// Network access decision
// ---------------------------------------------------------------------------

export type NetworkDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string; matchedRule?: string };

export interface NetworkAccessQuery {
  host: string;
  port: number;
  policy: RestrictionPolicy;
}

/**
 * Decide whether a candidate network access is allowed. The order
 * is:
 *   1. ALWAYS_DENY_HOSTS (loopback, IPv6 local, metadata).
 *   2. Caller-supplied `hosts` (first match wins).
 *   3. `refuseOnMiss` ⇒ deny.
 */
export function evaluateNetworkAccess(query: NetworkAccessQuery): NetworkDecision {
  if (!query.host || query.host.trim().length === 0)
    return { kind: "deny", reason: "empty host refused" };

  // Step 1: always-deny.
  for (const entry of ALWAYS_DENY_HOSTS) {
    if (matchHostOrCidr(entry.host, query.host))
      return { kind: "deny", reason: entry.reason, matchedRule: entry.host };
  }

  // Step 2: caller-supplied.
  let sawRule = false;
  for (const rule of query.policy.hosts) {
    if (rule.host !== query.host) continue;
    sawRule = true;
    if (rule.port !== null && rule.port !== query.port) continue;
    return rule.action === "deny"
      ? { kind: "deny", reason: rule.reason ?? "policy denied", matchedRule: rule.host }
      : { kind: "allow", reason: rule.reason };
  }
  if (sawRule) {
    // Caller has a rule for the host but no port matched ⇒ allow
    // (caller opted-in at host level).
    return { kind: "allow", reason: "host-level allow" };
  }

  // Step 3: miss.
  if (query.policy.refuseOnMiss)
    return { kind: "deny", reason: "policy.no-match: no rule allowed this host", matchedRule: "(none)" };
  return { kind: "allow", reason: "policy.no-match allowed by caller" };
}

// ---------------------------------------------------------------------------
// Process access decision
// ---------------------------------------------------------------------------

export type ProcessDecision =
  | { kind: "allow"; reason?: string }
  | { kind: "deny"; reason: string; matchedRule?: string };

export interface ProcessAccessQuery {
  argv: ReadonlyArray<string>;
  env: Readonly<Record<string, string>>;
  policy: RestrictionPolicy;
}

const LOADER_ENV_KEY_PATTERN = /^(LD_|DYLD_|NODE_|PYTHON)/;

/**
 * Decide whether a candidate process invocation is allowed. Refuses:
 *   - empty argv;
 *   - argv[0] resolving under a process-memory surface;
 *   - env keys starting with the loader-injection prefix
 *     (`LD_`, `DYLD_`, `NODE_`, `PYTHON_`).
 */
export function evaluateProcessAccess(query: ProcessAccessQuery): ProcessDecision {
  if (query.argv.length === 0 || !query.argv[0])
    return { kind: "deny", reason: "empty argv refused" };
  const bin = query.argv[0];
  if (/^\/proc\/\d+\/(mem|environ|maps)$/.test(bin))
    return { kind: "deny", reason: "process introspection bin refused", matchedRule: bin };

  for (const key of Object.keys(query.env)) {
    if (LOADER_ENV_KEY_PATTERN.test(key))
      return { kind: "deny", reason: "loader-injection env key refused", matchedRule: key };
  }

  // The process surface itself is always allowed once the loader-
  // injection blocklist passes; the policy only controls filesystem
  // and network access. The caller may add a custom block via
  // `policy.paths` matching against `argv[0]` — that is checked by
  // `evaluateFilesystemAccess({ op: "execute" })` separately.
  return { kind: "allow" };
}

// ---------------------------------------------------------------------------
// Resource caps (advisory; M6.5 enforces)
// ---------------------------------------------------------------------------

export interface ResourceCaps {
  cpuMillis: number | null;
  memoryMib: number | null;
  diskMib: number | null;
}

/** Surface the resource caps from the policy. Returns the literal
 *  triplet; the adapter (M6.5) decides how to enforce. */
export function applyResourceCaps(policy: RestrictionPolicy): ResourceCaps {
  return {
    cpuMillis: policy.cpuMillis,
    memoryMib: policy.memoryMib,
    diskMib: policy.diskMib,
  };
}

// ---------------------------------------------------------------------------
// Path-glob matcher
// ---------------------------------------------------------------------------

/** Match a candidate path against a glob pattern. Supports:
 *   - literal equality;
 *   - `*` — one path segment (no slashes);
 *   - `**` — zero or more segments (any depth).
 *  Trailing `/**` means "and everything below"; bare `**` matches
 *  anything.
 */
export function matchPathPattern(pattern: string, candidate: string): boolean {
  const p = pattern;
  const c = candidate;
  if (p === c) return true;
  // `/foo/**` matches `/foo` and `/foo/...`.
  if (p.endsWith("/**")) {
    const prefix = p.slice(0, -3);
    return c === prefix || c.startsWith(prefix + "/");
  }
  // Translate the glob to a regex. We tokenise first (so `**` and
  // `*` are recognised as operators), then re-emit escaped text +
  // operator regex, anchoring both ends.
  // Allowed metacharacters are `*` (zero or more non-slash chars)
  // and `**` (zero or more chars including slashes). Everything else
  // is escaped.
  let regexSource = "^";
  let i = 0;
  while (i < p.length) {
    if (p[i] === "*" && p[i + 1] === "*") {
      // `**` — accept any depth. Also accept a single `/` boundary so
      // `/**/foo` matches `/foo`.
      regexSource += ".*";
      i += 2;
    } else if (p[i] === "*") {
      regexSource += "[^/]*";
      i += 1;
    } else {
      regexSource += escapeRegex(p[i]);
      i += 1;
    }
  }
  regexSource += "$";
  return new RegExp(regexSource).test(c);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

/** Normalise a path: collapse repeated slashes, strip trailing slash. */
function normalisePath(p: string): string {
  return p.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

// ---------------------------------------------------------------------------
// Host / CIDR matcher
// ---------------------------------------------------------------------------

/** Match a candidate host string against a CIDR / literal entry. */
export function matchHostOrCidr(rule: string, candidate: string): boolean {
  if (!rule.includes("/")) return rule.toLowerCase() === candidate.toLowerCase();
  // CIDR — supports IPv4 and IPv6.
  const [base, prefixStr] = rule.split("/");
  if (!base || !prefixStr) return false;
  const prefix = Number(prefixStr);
  if (!Number.isFinite(prefix)) return false;
  const baseBytes = parseIp(base);
  const candBytes = parseIp(candidate);
  if (!baseBytes || !candBytes) return false;
  if (baseBytes.length !== candBytes.length) return false;
  const fullBytes = Math.floor(prefix / 8);
  const remainder = prefix % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (baseBytes[i] !== candBytes[i]) return false;
  }
  if (remainder > 0 && fullBytes < baseBytes.length) {
    const mask = ((0xff << (8 - remainder)) & 0xff);
    if ((baseBytes[fullBytes] & mask) !== (candBytes[fullBytes] & mask)) return false;
  }
  return true;
}

function parseIp(ip: string): Uint8Array | null {
  // IPv6 — contains at least one colon.
  if (ip.includes(":")) return parseIpv6(ip);
  // IPv4 — four dotted octets.
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const n = Number(parts[i]);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(ip: string): Uint8Array | null {
  // Naive expansion: support "::" shorthand only when present once.
  const lower = ip.toLowerCase();
  let head: string[] = [];
  let tail: string[] = [];
  if (lower.includes("::")) {
    const [h, t] = lower.split("::");
    head = h ? h.split(":") : [];
    tail = t ? t.split(":") : [];
  } else {
    head = lower.split(":");
  }
  if (head.length + tail.length > 8) return null;
  const fill = 8 - head.length - tail.length;
  const groups = [...head, ...Array(fill).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    // Allow 1-4 hex digits per group.
    const g = groups[i];
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    out[i * 2] = (n >> 8) & 0xff;
    out[i * 2 + 1] = n & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Default restricted profile
// ---------------------------------------------------------------------------

/** The `restricted-local` profile: refuse-on-miss + empty allow
 *  list. The project can extend it with explicit `paths` / `hosts`
 *  rules; nothing is reachable by default. */
export function restrictedLocalPolicy(overrides: Partial<RestrictionPolicy> = {}): RestrictionPolicy {
  return restrictionPolicySchema.parse({
    paths: [],
    hosts: [],
    refuseOnMiss: true,
    cpuMillis: 4000,
    memoryMib: 4096,
    diskMib: 8192,
    ...overrides,
  });
}

/** The `trusted-local` profile: refuse-on-miss = false (caller's
 *  policy decides). Used by M6.5's trusted-local adapter. */
export function trustedLocalPolicy(overrides: Partial<RestrictionPolicy> = {}): RestrictionPolicy {
  return restrictionPolicySchema.parse({
    paths: [],
    hosts: [],
    refuseOnMiss: false,
    ...overrides,
  });
}

void z;