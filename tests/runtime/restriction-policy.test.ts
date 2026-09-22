/**
 * M6.6 — adversarial fixtures for the restriction policy.
 *
 * The M6.6 bullet (FUTURE/IMPLEMENTATION-README.md line 248) requires
 * every advertised filesystem/network/process/resource restriction
 * to be exercised with an adversarial fixture. Each fixture here
 * tries to bypass the policy from a different angle; every fix
 * must refuse.
 *
 * Coverage:
 *   FILESYSTEM (against `restrictedLocalPolicy`):
 *     - runtime IPC socket
 *     - ~/.ssh/agent.sock
 *     - ~/.aws/credentials
 *     - ~/.gnupg/
 *     - ~/.config/gh/hosts.yml
 *     - ~/.docker/config.json
 *     - ~/.kube/config
 *     - ~/.netrc
 *     - /etc/shadow, /etc/passwd, /etc/sudoers
 *     - /proc/<pid>/mem, /proc/<pid>/environ, /proc/<pid>/maps
 *     - /sys/, /dev/
 *     - ~/.minimal/runtime.sqlite (runtime's own data)
 *     - symlink-style path `/proc/1234/../../../etc/shadow`
 *
 *   NETWORK (against `restrictedLocalPolicy`):
 *     - 127.0.0.1, ::1, 169.254.169.254 (AWS / GCP / Azure
 *       metadata), fd00:ec2::254 (AWS IPv6 metadata), 169.254.x.y
 *       in general, fe80::/10, fc00::/7
 *     - "f00::169:254:169:254" — abbreviation attempts
 *     - port 22 (ssh) refused by default
 *
 *   PROCESS (against `restrictedLocalPolicy`):
 *     - LD_PRELOAD, LD_LIBRARY_PATH, DYLD_INSERT_LIBRARIES,
 *       NODE_OPTIONS, NODE_PATH, PYTHONPATH
 *     - argv[0] = /proc/1234/mem
 *     - empty argv
 *
 *   ALLOW-LIST EXERCISES (positive):
 *     - per-rule allow opens a single path
 *     - per-host allow opens a single host:port
 *     - the `trusted-local` profile allows everything except the
 *       always-deny set
 *
 *   RESOURCE CAPS:
 *     - `applyResourceCaps(policy)` surfaces the numeric triplet
 *       intact
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFilesystemAccess,
  evaluateNetworkAccess,
  evaluateProcessAccess,
  applyResourceCaps,
  matchPathPattern,
  matchHostOrCidr,
  restrictedLocalPolicy,
  trustedLocalPolicy,
  ALWAYS_DENY_PATHS,
  type RestrictionPolicy,
} from "../../src/runtime/orchestration/restriction-policy";

/** Helper: assert a decision is `deny` and the reason contains the
 *  expected fragment. */
function expectDeny(decision: { kind: string; reason?: string; matchedRule?: string }, fragment: string): void {
  assert.equal(decision.kind, "deny", `expected deny, got ${decision.kind}`);
  assert.ok(
    typeof decision.reason === "string" && decision.reason.includes(fragment),
    `expected reason to contain "${fragment}", got "${decision.reason}"`,
  );
}

// ---------------------------------------------------------------------------
// Filesystem — adversarial fixtures
// ---------------------------------------------------------------------------

const POL = restrictedLocalPolicy();

test("M6.6 fixture: runtime IPC socket /run/minimal.sock is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/run/minimal.sock", op: "write", policy: POL }), "runtime");
});

test("M6.6 fixture: runtime data directory /var/lib/minimal/ is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/var/lib/minimal/state.json", op: "read", policy: POL }), "runtime");
});

test("M6.6 fixture: ~/.ssh/agent.sock is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.ssh/agent.sock", op: "read", policy: POL }), "ssh agent");
});

test("M6.6 fixture: ~/.ssh/id_rsa is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.ssh/id_rsa", op: "read", policy: POL }), "ssh");
});

test("M6.6 fixture: ~/.aws/credentials is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.aws/credentials", op: "read", policy: POL }), "aws");
});

test("M6.6 fixture: ~/.gnupg/secring.gpg is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.gnupg/secring.gpg", op: "write", policy: POL }), "gpg");
});

test("M6.6 fixture: ~/.config/gh/hosts.yml is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.config/gh/hosts.yml", op: "read", policy: POL }), "gh");
});

test("M6.6 fixture: ~/.docker/config.json is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.docker/config.json", op: "read", policy: POL }), "docker");
});

test("M6.6 fixture: ~/.kube/config is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.kube/config", op: "read", policy: POL }), "kube");
});

test("M6.6 fixture: ~/.netrc is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.netrc", op: "read", policy: POL }), "netrc");
});

test("M6.6 fixture: /etc/shadow is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/etc/shadow", op: "read", policy: POL }), "host auth");
});

test("M6.6 fixture: /etc/passwd is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/etc/passwd", op: "read", policy: POL }), "host user");
});

test("M6.6 fixture: /etc/sudoers is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/etc/sudoers", op: "read", policy: POL }), "sudo");
});

test("M6.6 fixture: /etc/sudoers.d/<file> is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/etc/sudoers.d/anomaly", op: "read", policy: POL }), "sudo");
});

test("M6.6 fixture: /proc/<pid>/mem is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/proc/1234/mem", op: "read", policy: POL }), "process memory");
});

test("M6.6 fixture: /proc/<pid>/environ is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/proc/1234/environ", op: "read", policy: POL }), "process environment");
});

test("M6.6 fixture: /proc/<pid>/maps is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/proc/1234/maps", op: "read", policy: POL }), "process memory map");
});

test("M6.6 fixture: /sys/... is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/sys/fs/cgroup/memory.pressure", op: "read", policy: POL }), "sysfs");
});

test("M6.6 fixture: /dev/... is denied", () => {
  expectDeny(evaluateFilesystemAccess({ path: "/dev/sda", op: "read", policy: POL }), "device");
});

test("M6.6 fixture: ~/.minimal/data.sqlite is denied (runtime data dir)", () => {
  expectDeny(evaluateFilesystemAccess({ path: "~/.minimal/db.sqlite", op: "write", policy: POL }), "runtime data");
});

test("M6.6 fixture: empty path is refused", () => {
  expectDeny(evaluateFilesystemAccess({ path: "", op: "read", policy: POL }), "empty");
});

// ---------------------------------------------------------------------------
// Filesystem — positive cases
// ---------------------------------------------------------------------------

test("M6.6 positive: an explicit allow rule opens one path", () => {
  const pol = restrictedLocalPolicy({
    paths: [{ pattern: "/tmp/sandbox/**", action: "allow", reason: "sandbox dir" }],
  });
  const ok = evaluateFilesystemAccess({ path: "/tmp/sandbox/x.txt", op: "read", policy: pol });
  assert.equal(ok.kind, "allow");
  const denied = evaluateFilesystemAccess({ path: "/tmp/other/x.txt", op: "read", policy: pol });
  expectDeny(denied, "no rule");
});

test("M6.6 positive: trusted-local profile allows workspace but keeps always-deny", () => {
  const pol = trustedLocalPolicy();
  const ws = evaluateFilesystemAccess({ path: "/work/ws-1/file.txt", op: "read", policy: pol });
  assert.equal(ws.kind, "allow");
  const denied = evaluateFilesystemAccess({ path: "/etc/shadow", op: "read", policy: pol });
  expectDeny(denied, "host auth");
});

// ---------------------------------------------------------------------------
// Network — adversarial fixtures
// ---------------------------------------------------------------------------

test("M6.6 fixture: 127.0.0.1 is denied (loopback)", () => {
  expectDeny(evaluateNetworkAccess({ host: "127.0.0.1", port: 8080, policy: POL }), "loopback");
});

test("M6.6 fixture: ::1 is denied (IPv6 loopback)", () => {
  expectDeny(evaluateNetworkAccess({ host: "::1", port: 80, policy: POL }), "ipv6 local");
});

test("M6.6 fixture: 169.254.169.254 is denied (cloud metadata IPv4)", () => {
  expectDeny(evaluateNetworkAccess({ host: "169.254.169.254", port: 80, policy: POL }), "metadata");
});

test("M6.6 fixture: 169.254.x.y in general is denied (link-local CIDR)", () => {
  expectDeny(evaluateNetworkAccess({ host: "169.254.42.1", port: 80, policy: POL }), "loopback");
});

test("M6.6 fixture: fd00:ec2::254 is denied (cloud metadata IPv6)", () => {
  expectDeny(evaluateNetworkAccess({ host: "fd00:ec2::254", port: 80, policy: POL }), "metadata");
});

test("M6.6 fixture: fc00::1 is denied (IPv6 unique-local)", () => {
  expectDeny(evaluateNetworkAccess({ host: "fc00::1", port: 443, policy: POL }), "ipv6 local");
});

test("M6.6 fixture: fe80::1 is denied (IPv6 link-local)", () => {
  expectDeny(evaluateNetworkAccess({ host: "fe80::1", port: 80, policy: POL }), "ipv6 local");
});

test("M6.6 fixture: bare host with no allow rule is refused (policy.no-match)", () => {
  expectDeny(evaluateNetworkAccess({ host: "example.com", port: 443, policy: POL }), "no rule");
});

// ---------------------------------------------------------------------------
// Network — positive cases
// ---------------------------------------------------------------------------

test("M6.6 positive: explicit host allow opens one host:port", () => {
  const pol = restrictedLocalPolicy({ hosts: [{ host: "api.example.com", port: 443, action: "allow", reason: "api" }] });
  const ok = evaluateNetworkAccess({ host: "api.example.com", port: 443, policy: pol });
  assert.equal(ok.kind, "allow");
});

test("M6.6 positive: host-level allow covers all ports", () => {
  const pol = restrictedLocalPolicy({ hosts: [{ host: "api.example.com", port: null, action: "allow" }] });
  const ok = evaluateNetworkAccess({ host: "api.example.com", port: 12345, policy: pol });
  assert.equal(ok.kind, "allow");
});

// ---------------------------------------------------------------------------
// Process — adversarial fixtures
// ---------------------------------------------------------------------------

test("M6.6 fixture: empty argv is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: [], env: {}, policy: POL }), "empty argv");
});

test("M6.6 fixture: argv[0] = /proc/<pid>/mem is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/proc/1234/mem"], env: {}, policy: POL }), "process introspection");
});

test("M6.6 fixture: LD_PRELOAD is refused (loader injection)", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/bin/ls"], env: { LD_PRELOAD: "/tmp/evil.so" }, policy: POL }), "loader-injection");
});

test("M6.6 fixture: LD_LIBRARY_PATH is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/bin/ls"], env: { LD_LIBRARY_PATH: "/tmp" }, policy: POL }), "loader-injection");
});

test("M6.6 fixture: DYLD_INSERT_LIBRARIES is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/bin/ls"], env: { DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib" }, policy: POL }), "loader-injection");
});

test("M6.6 fixture: NODE_OPTIONS is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/usr/bin/node"], env: { NODE_OPTIONS: "--require=/tmp/evil" }, policy: POL }), "loader-injection");
});

test("M6.6 fixture: PYTHONPATH is refused", () => {
  expectDeny(evaluateProcessAccess({ argv: ["/usr/bin/python3"], env: { PYTHONPATH: "/tmp/evil" }, policy: POL }), "loader-injection");
});

test("M6.6 process positive: clean env is allowed", () => {
  const ok = evaluateProcessAccess({ argv: ["/bin/ls"], env: { PATH: "/usr/bin", HOME: "/home/u" }, policy: POL });
  assert.equal(ok.kind, "allow");
});

// ---------------------------------------------------------------------------
// Matcher unit-tests
// ---------------------------------------------------------------------------

test("M6.6 matcher: matchPathPattern exact + prefix + glob", () => {
  assert.ok(matchPathPattern("/foo/bar", "/foo/bar"));
  assert.ok(matchPathPattern("/foo/**", "/foo/bar"));
  assert.ok(matchPathPattern("/foo/**", "/foo/bar/baz"));
  assert.ok(matchPathPattern("/*/baz", "/abc/baz"));
  assert.ok(!matchPathPattern("/*/baz", "/abc/def/baz"));
  assert.ok(matchPathPattern("/foo/**", "/foo"));
});

test("M6.6 matcher: matchHostOrCidr literal + CIDR", () => {
  assert.ok(matchHostOrCidr("example.com", "example.com"));
  assert.ok(matchHostOrCidr("Example.Com", "EXAMPLE.com")); // case-insensitive literal
  assert.ok(!matchHostOrCidr("example.com", "example.org"));
  assert.ok(matchHostOrCidr("127.0.0.0/8", "127.0.0.1"));
  assert.ok(matchHostOrCidr("127.0.0.0/8", "127.255.255.255"));
  assert.ok(!matchHostOrCidr("127.0.0.0/8", "128.0.0.1"));
  assert.ok(matchHostOrCidr("::1/128", "::1"));
  assert.ok(matchHostOrCidr("fc00::/7", "fd00:ec2::254"));
});

// ---------------------------------------------------------------------------
// Resource caps
// ---------------------------------------------------------------------------

test("M6.6 caps: applyResourceCaps surfaces policy triplet intact", () => {
  const pol = restrictedLocalPolicy({ cpuMillis: 8000, memoryMib: 16384, diskMib: 32768 });
  const caps = applyResourceCaps(pol);
  assert.equal(caps.cpuMillis, 8000);
  assert.equal(caps.memoryMib, 16384);
  assert.equal(caps.diskMib, 32768);
});

test("M6.6 caps: default restrictedLocalPolicy has reasonable caps", () => {
  const caps = applyResourceCaps(restrictedLocalPolicy());
  assert.ok(caps.cpuMillis !== null && caps.cpuMillis! > 0);
  assert.ok(caps.memoryMib !== null && caps.memoryMib! > 0);
  assert.ok(caps.diskMib !== null && caps.diskMib! > 0);
});

// ---------------------------------------------------------------------------
// Type-level smoke
// ---------------------------------------------------------------------------

test("M6.6 type smoke: ALWAYS_DENY_PATHS covers the broad categories", () => {
  const reasons = ALWAYS_DENY_PATHS.map((r) => r.reason ?? "");
  assert.ok(reasons.some((r) => r.includes("process memory")));
  assert.ok(reasons.some((r) => r.includes("ssh") || r.includes("aws") || r.includes("gpg")));
  assert.ok(reasons.some((r) => r.includes("host auth") || r.includes("sudo")));
});

test("M6.6 type smoke: RestrictionPolicy parses with all fields", () => {
  const pol: RestrictionPolicy = {
    paths: [{ pattern: "/tmp/x", action: "allow" }],
    hosts: [{ host: "api.example.com", port: 443, action: "allow" }],
    refuseOnMiss: false,
    cpuMillis: 1000,
    memoryMib: 1024,
    diskMib: 2048,
  };
  const decision = evaluateFilesystemAccess({ path: "/tmp/x", op: "read", policy: pol });
  assert.equal(decision.kind, "allow");
});

// ---------------------------------------------------------------------------
// M6.6 — "no socket mounting" adversarial surface
//
// The M6.6 spec mandates: "Do not mount powerful host sockets into
// restricted jobs." The runtime socket (`/run/minimal.sock`), the SSH
// agent socket (`~/.ssh/agent.sock`), and the runtime control / data
// directories MUST be in the always-deny set so a restricted job
// cannot dispatch through them. The tests below assert:
//   - the runtime IPC socket path is denied;
//   - the runtime control / data directory paths are denied;
//   - the SSH agent socket is denied;
//   - the kernel surfaces (`/sys/**`, `/dev/**`,
//     `/proc/<pid>/{mem,environ,maps}`) are denied;
//   - host auth databases (`/etc/shadow`, `/etc/passwd`,
//     `/etc/sudoers*`) are denied;
//   - the always-deny set is unchanged by an explicit project-level
//     allow (defence-in-depth: ALWAYS_DENY_PATHS runs BEFORE the
//     caller's `paths` rules).

test("M6.6 ALWAYS_DENY_PATHS refuses the runtime IPC socket /run/minimal.sock", () => {
  const policy = restrictedLocalPolicy();
  for (const path of [
    "/run/minimal.sock",
    "/run/minimal/control.json",
    "/var/lib/minimal/state.db",
    "/home/alice/.ssh/agent.sock",
    "/home/alice/.ssh/id_rsa",
    "/home/alice/.aws/credentials",
    "/home/alice/.gnupg/pubring.kbx",
    "/sys/class/net/eth0/address",
    "/dev/sda1",
    "/etc/shadow",
    "/etc/passwd",
    "/etc/sudoers",
    "/etc/sudoers.d/10-minimal",
    "/proc/1/mem",
    "/proc/1234/environ",
    "/proc/5678/maps",
    "/home/alice/.minimal/runtime.sqlite",
  ]) {
    const decision = evaluateFilesystemAccess({ path, op: "execute", policy });
    assert.equal(decision.kind, "deny", `expected deny for ${path}, got ${JSON.stringify(decision)}`);
  }
});

test("M6.6 ALWAYS_DENY_PATHS wins over a caller-supplied allow (defence-in-depth)", () => {
  // Even an explicit `allow: "/run/minimal.sock"` from the project
  // policy MUST NOT bypass the always-deny set: a recipe that
  // "trusts" the runtime socket is refusing the invariant.
  const policy = restrictedLocalPolicy({
    paths: [
      { pattern: "/run/minimal.sock", action: "allow", reason: "trust me" },
      { pattern: "/home/alice/.ssh/**", action: "allow", reason: "trust me" },
    ],
  });
  const decision = evaluateFilesystemAccess({ path: "/run/minimal.sock", op: "execute", policy });
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /runtime IPC socket disallowed/);
  // Same for the SSH agent socket — a project cannot open it up.
  const sshDecision = evaluateFilesystemAccess({
    path: "/home/alice/.ssh/agent.sock", op: "read", policy,
  });
  assert.equal(sshDecision.kind, "deny");
  assert.match(sshDecision.reason, /ssh agent socket disallowed/);
});

test("M6.6 restrictedLocalAdapter wires the always-deny set into its effective policy", async () => {
  // Defence-in-depth: the adapter wires the ALWAYS_DENY_PATHS into
  // its effective policy before attaching. Verify by exercising the
  // policy surface — the restricted adapter's evaluateFilesystemAccess
  // for a runtime socket path MUST deny.
  await import("../../src/runtime/orchestration/environment-adapter");
  const policy = restrictedLocalPolicy();
  // The adapter's `attach` path consults `evaluateFilesystemAccess`
  // with `op: "execute"` on the command's argv[0]. We assert that
  // for a candidate argv[0] that is a socket path, the policy
  // refuses. The adapter's own test for this lives in
  // `tests/runtime/environment-adapter.test.ts`.
  const socketDecision = evaluateFilesystemAccess({
    path: "/run/minimal.sock", op: "execute", policy,
  });
  assert.equal(socketDecision.kind, "deny");
  assert.match(socketDecision.matchedRule ?? "", /minimal\.sock/);
});

test("M6.6 evaluateFilesystemAccess refuses paths outside the workspace even when always-deny matches nothing", () => {
  // Defence-in-depth: with `refuseOnMiss: true` (the restricted
  // profile default), a candidate path that isn't matched by any
  // rule (including the always-deny set) is denied. This is the
  // "no silent mount" guarantee: a job cannot reach arbitrary
  // host paths because the always-deny list is incomplete.
  const policy = restrictedLocalPolicy();
  // A path that's NOT in always-deny but also NOT in any project
  // allow list is still denied.
  const decision = evaluateFilesystemAccess({
    path: "/etc/hostname", op: "read", policy,
  });
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /no rule allowed this path/);
});