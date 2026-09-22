/**
 * M9 — release qualification tests.
 *
 * Coverage:
 *   1. `scrubRecord` allowlists known fields and redacts unknown ones.
 *   2. `scrubRecord` strips canary secrets from allowed fields.
 *   3. `scrubRecord` reports `canaryMisses` when a canary escapes.
 *   4. `scrubBundle` refuses when any canary escapes scrubbing.
 *   5. `scrubRecord` preserves retention floor for non-operational
 *      classes (never silently drops).
 *   6. `probeCompatibility` flags unsupported architectures / runtimes
 *      / filesystems / distros.
 *   7. `probeCompatibility` accepts a fully-supported host probe.
 *   8. `runChecklist` runs each step's verifier in order and records
 *      evidence; a failing step refuses the release.
 *   9. `runChecklist` skips steps that have no verifier registered.
 *  10. `verifyManifest` matches on-disk digests; mismatches and
 *      missing files are surfaced.
 *  11. `computeManifestDigest` is stable for the same input.
 *  12. `verifySignatureShape` refuses a manifest with a signature but
 *      no `signedBy` (or vice versa).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  scrubRecord,
  scrubBundle,
  detectCanaryPatterns,
} from "../../src/release/diagnostic-scrubber";
import {
  probeCompatibility,
  SUPPORTED_ARCHITECTURES,
  SUPPORTED_RUNTIMES,
  SUPPORTED_DISTROS,
} from "../../src/release/compatibility-check";
import {
  runChecklist,
  type ReleaseChecklist,
} from "../../src/release/release-checklist";
import {
  verifyManifest,
  computeManifestDigest,
  verifySignatureShape,
  artifactManifestSchema,
  type ArtifactManifest,
} from "../../src/release/integrity-verify";

// ---------------------------------------------------------------------------
// Diagnostic scrubber (M9.4)
// ---------------------------------------------------------------------------

test("M9 scrubRecord allowlists known fields + redacts unknowns", () => {
  const result = scrubRecord({
    timestamp: "2026-01-01T00:00:00Z",
    correlationId: "abc",
    level: "info",
    message: "ok",
    password: "hunter2",
    apiKey: "sk-test-1234",
    filesystemPath: "/home/user/.ssh/id_rsa",
  });
  assert.equal(result.redacted.timestamp, "2026-01-01T00:00:00Z");
  assert.equal(result.redacted.correlationId, "abc");
  assert.equal(result.redacted.password, "[REDACTED]");
  assert.equal(result.redacted.apiKey, "[REDACTED]");
  assert.equal(result.redacted.filesystemPath, "[REDACTED]");
  assert.equal(result.redactionCount, 3);
  assert.deepEqual(result.droppedKeys, ["password", "apiKey", "filesystemPath"]);
});

test("M9 scrubRecord strips canary secrets from allowed fields", () => {
  const canarySecret = "AKIAIOSFODNN7EXAMPLE";
  const result = scrubRecord({
    timestamp: "2026-01-01T00:00:00Z",
    message: `event fired with key=${canarySecret}`,
  }, {
    canaries: [{ name: "aws-access-key", value: canarySecret }],
  });
  assert.equal(result.canaryMatches, 1);
  assert.deepEqual(result.canaryMisses, []);
  assert.ok(!(result.redacted.message as string).includes(canarySecret));
  assert.ok((result.redacted.message as string).includes("[CANARY]"));
});

test("M9 scrubRecord reports canaryMisses when canary escapes", () => {
  const result = scrubRecord({
    timestamp: "2026-01-01T00:00:00Z",
    message: "no secrets here",
  }, {
    canaries: [{ name: "missing", value: "this-string-is-not-in-the-record" }],
  });
  assert.equal(result.canaryMatches, 0);
  assert.deepEqual(result.canaryMisses, ["missing"]);
});

test("M9 scrubBundle refuses when any canary escapes", () => {
  const bundle = scrubBundle([
    { timestamp: "2026-01-01T00:00:00Z", message: "hello" },
    { timestamp: "2026-01-02T00:00:00Z", message: "no leaks" },
  ], {
    canaries: [{ name: "ghost", value: "ghost-secret" }],
  });
  assert.deepEqual([...bundle.failedCanaries], ["ghost"]);
});

test("M9 scrubRecord preserves retention floor for non-operational classes", () => {
  const result = scrubRecord({
    timestamp: "2026-01-01T00:00:00Z",
    correlationId: "decision-1",
    message: "user has not yet approved",
  }, {
    retentionClass: "pending-decision",
  });
  assert.equal(result.retentionPreserved, true);
  assert.equal(result.redacted.correlationId, "decision-1");
});

test("M9 detectCanaryPatterns matches common secret shapes", () => {
  const matches = detectCanaryPatterns(
    "home=/home/alice ssh=-----BEGIN RSA PRIVATE KEY----- aws=AKIAIOSFODNN7EXAMPLE",
  );
  assert.ok(matches.includes("ssh-private-key"));
  assert.ok(matches.includes("aws-access-key"));
  assert.ok(matches.includes("home-directory"));
});

// ---------------------------------------------------------------------------
// Compatibility check (M9.1)
// ---------------------------------------------------------------------------

test("M9 probeCompatibility accepts a fully-supported host", async () => {
  const probe = await probeCompatibility({
    detectArchitecture: () => "x64",
    detectRuntime: () => "v22.5.0",
    detectFilesystem: async () => "ext4",
    detectDistro: () => "ubuntu-24.04",
    detectProviders: () => ["claude-sonnet", "gpt-4o"],
    detectSqlite: () => true,
    detectRootlessContainer: () => true,
    probePath: "/tmp",
  });
  assert.equal(probe.supported, true);
  assert.equal(probe.unsupportedReasons.length, 0);
  assert.equal(probe.architecture, "x64");
});

test("M9 probeCompatibility flags unsupported architecture + runtime + filesystem", async () => {
  const probe = await probeCompatibility({
    detectArchitecture: () => "ia32",
    detectRuntime: () => "v18.0.0",
    detectFilesystem: async () => "zfs-pool-x",
    detectDistro: () => "ubuntu-24.04",
    detectProviders: () => [],
    detectSqlite: () => true,
    detectRootlessContainer: () => true,
  });
  assert.equal(probe.supported, false);
  assert.ok(probe.unsupportedReasons.some((r) => r.includes("ia32")));
  assert.ok(probe.unsupportedReasons.some((r) => r.includes("v18")));
  assert.ok(probe.unsupportedReasons.some((r) => r.includes("zfs-pool-x")));
});

test("M9 probeCompatibility flags missing sqlite + missing rootless engine", async () => {
  const probe = await probeCompatibility({
    detectArchitecture: () => "x64",
    detectRuntime: () => "v22.0.0",
    detectFilesystem: async () => "ext4",
    detectDistro: () => "debian-12",
    detectSqlite: () => false,
    detectRootlessContainer: () => false,
  });
  assert.equal(probe.supported, false);
  assert.ok(probe.unsupportedReasons.some((r) => r.includes("node:sqlite")));
  assert.ok(probe.unsupportedReasons.some((r) => r.includes("rootless")));
});

test("M9 supported lists are non-empty and cover x64 + arm64", () => {
  assert.ok(SUPPORTED_ARCHITECTURES.includes("x64"));
  assert.ok(SUPPORTED_ARCHITECTURES.includes("arm64"));
  assert.ok(SUPPORTED_RUNTIMES.includes("22.x"));
  assert.ok(SUPPORTED_DISTROS.includes("ubuntu-24.04"));
});

// ---------------------------------------------------------------------------
// Release checklist (M9.0 / M9.1)
// ---------------------------------------------------------------------------

test("M9 runChecklist runs verifiers in order and records evidence", async () => {
  const checklist: ReleaseChecklist = {
    id: "rc-1", checkpoint: "local-workspace",
    steps: [
      { id: "import", label: "Import dirty project", rationale: "M9.0" },
      { id: "activate", label: "Activate resources", rationale: "M9.0" },
      { id: "export", label: "Export workspace", rationale: "M9.0" },
    ],
  };
  const calls: string[] = [];
  const report = await runChecklist(checklist, {
    import: async () => { calls.push("import"); return { dirty: true }; },
    activate: async () => { calls.push("activate"); return { activated: 2 }; },
    export: async () => { calls.push("export"); return { exported: true }; },
  });
  assert.equal(report.passed, true);
  assert.deepEqual(calls, ["import", "activate", "export"]);
  assert.equal(report.steps.find((s) => s.id === "import")!.evidence.dirty, true);
  assert.equal(report.steps.find((s) => s.id === "activate")!.evidence.activated, 2);
});

test("M9 runChecklist fails the release when any step throws", async () => {
  const checklist: ReleaseChecklist = {
    id: "rc-2", checkpoint: "remote",
    steps: [
      { id: "register", label: "Register host", rationale: "M8.1" },
      { id: "schedule", label: "Schedule on host", rationale: "M8.6" },
    ],
  };
  const report = await runChecklist(checklist, {
    register: async () => ({ hostId: "h1" }),
    schedule: async () => { throw new Error("network partition"); },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(report.failedStepIds, ["schedule"]);
  assert.equal(report.steps.find((s) => s.id === "schedule")!.error, "network partition");
});

test("M9 runChecklist skips steps without a verifier", async () => {
  const checklist: ReleaseChecklist = {
    id: "rc-3", checkpoint: "pilot",
    steps: [
      { id: "import", label: "Import", rationale: "M9.0" },
      { id: "manual-step", label: "Manual verification", rationale: "M9.0" },
    ],
  };
  const report = await runChecklist(checklist, {
    import: async () => ({ ok: true }),
  });
  assert.equal(report.passed, true);
  assert.deepEqual(report.skippedStepIds, ["manual-step"]);
});

// ---------------------------------------------------------------------------
// Integrity verify (M9.2)
// ---------------------------------------------------------------------------

function makeManifest(entries: Array<{ path: string; content: Buffer }>): ArtifactManifest {
  const manifestEntries = entries.map((e) => ({
    path: e.path,
    digest: createHash("sha256").update(e.content).digest("hex"),
    byteSize: e.content.byteLength,
  }));
  return artifactManifestSchema.parse({
    artifactId: "minimal-linux-x64",
    version: "1.2.0",
    platform: "linux-x64",
    entries: manifestEntries,
    signature: null,
    signedBy: null,
    manifestDigest: "0".repeat(64),
  });
}

test("M9 verifyManifest matches on-disk digests; surfaces mismatches + missing", async () => {
  const files = new Map<string, Buffer>([
    ["minimal", Buffer.from("binary content", "utf8")],
    ["docs/readme.md", Buffer.from("# hello", "utf8")],
  ]);
  const manifest = makeManifest([...files].map(([path, content]) => ({ path, content })));
  const result = await verifyManifest(manifest, "/artifact", {
    readFile: async (p) => {
      const rel = p.replace("/artifact/", "");
      const buf = files.get(rel);
      if (!buf) throw new Error(`ENOENT ${rel}`);
      return buf;
    },
    presentFiles: [...files.keys()],
  });
  assert.equal(result.passed, true);
  assert.equal(result.mismatched.length, 0);
  assert.equal(result.missing.length, 0);
});

test("M9 verifyManifest reports a mismatch when the on-disk file is corrupted", async () => {
  const files = new Map<string, Buffer>([["minimal", Buffer.from("original", "utf8")]]);
  const manifest = makeManifest([{ path: "minimal", content: Buffer.from("original", "utf8") }]);
  files.set("minimal", Buffer.from("TAMPERED", "utf8"));
  const result = await verifyManifest(manifest, "/artifact", {
    readFile: async (p) => {
      const rel = p.replace("/artifact/", "");
      return files.get(rel)!;
    },
    presentFiles: ["minimal"],
  });
  assert.equal(result.passed, false);
  assert.equal(result.mismatched.length, 1);
  assert.equal(result.mismatched[0].path, "minimal");
});

test("M9 verifyManifest reports a missing file", async () => {
  const manifest = makeManifest([{ path: "minimal", content: Buffer.from("content", "utf8") }]);
  const result = await verifyManifest(manifest, "/artifact", {
    readFile: async () => { throw new Error("ENOENT"); },
    presentFiles: [],
  });
  assert.equal(result.passed, false);
  assert.deepEqual(result.missing, ["minimal"]);
});

test("M9 computeManifestDigest is stable for the same input", () => {
  const manifest = makeManifest([
    { path: "a", content: Buffer.from("AAA", "utf8") },
    { path: "b", content: Buffer.from("BBB", "utf8") },
  ]);
  const d1 = computeManifestDigest(manifest);
  const d2 = computeManifestDigest(manifest);
  assert.equal(d1, d2);
  assert.match(d1, /^[0-9a-f]{64}$/);
});

test("M9 verifySignatureShape refuses a signature without signedBy", () => {
  const manifest: ArtifactManifest = artifactManifestSchema.parse({
    artifactId: "x", version: "1.0.0", platform: "linux-x64",
    manifestDigest: "0".repeat(64),
    entries: [{ path: "a", digest: "0".repeat(64), byteSize: 0 }],
    signature: "sig-data", signedBy: null,
  });
  const shape = verifySignatureShape(manifest);
  assert.equal(shape.ok, false);
  assert.match(shape.error!, /signedBy/);
});

test("M9 verifySignatureShape refuses a signedBy without signature", () => {
  const manifest: ArtifactManifest = artifactManifestSchema.parse({
    artifactId: "x", version: "1.0.0", platform: "linux-x64",
    manifestDigest: "0".repeat(64),
    entries: [{ path: "a", digest: "0".repeat(64), byteSize: 0 }],
    signature: null, signedBy: "key-1",
  });
  const shape = verifySignatureShape(manifest);
  assert.equal(shape.ok, false);
  assert.match(shape.error!, /signature/);
});

test("M9 verifySignatureShape accepts an unsigned manifest", () => {
  const manifest: ArtifactManifest = artifactManifestSchema.parse({
    artifactId: "x", version: "1.0.0", platform: "linux-x64",
    manifestDigest: "0".repeat(64),
    entries: [{ path: "a", digest: "0".repeat(64), byteSize: 0 }],
    signature: null, signedBy: null,
  });
  const shape = verifySignatureShape(manifest);
  assert.equal(shape.ok, true);
  assert.equal(shape.error, null);
});
