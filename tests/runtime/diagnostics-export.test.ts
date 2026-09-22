/**
 * M9.4 — end-to-end canary test.
 *
 * Plants 6 canary tokens (one per default pattern) into a real
 * `Logger` write, drains the NDJSON, and runs the scrubber. The
 * `failedCanaries` array MUST be empty: every canary token must be
 * caught by the allowlist+canary pass.
 *
 * The companion positive test confirms that a planted canary that is
 * NOT scrubbed triggers `failedCanaries.length > 0`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Logger } from "../../src/main/logging";
import { scrubBundle, detectCanaryPatterns } from "../../src/release/diagnostic-scrubber";

const PLANTED_TOKENS = [
  { name: "ssh-private-key", value: "-----BEGIN OPENSSH PRIVATE KEY-----" },
  { name: "aws-access-key", value: "AKIAIOSFODNN7EXAMPLE" },
  { name: "github-token", value: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { name: "home-directory", value: "/home/alice/projects/secret" },
  { name: "bearer-token", value: "Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  { name: "hex-secret-32", value: "0123456789abcdef0123456789abcdef" },
];

async function fixtureLogger() {
  const root = await mkdtemp(path.join(tmpdir(), "minimal-canary-"));
  const logger = new Logger(root, 7);
  return { root, logger, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("canary tokens planted in a real log entry are caught by scrubBundle", async () => {
  const { root, logger, cleanup } = await fixtureLogger();
  try {
    // Plant all 6 canary tokens in a SINGLE log entry. The scrubber's
    // contract is "every canary that appears in any record is
    // detected"; if any one of these canaries is missing from the
    // bundle report, the scrubber missed a leaked secret.
    await logger.write({
      level: "info",
      source: "test",
      event: "all-canaries",
      fields: {
        hostId: PLANTED_TOKENS.map((t) => t.value).join(" | "),
        message: PLANTED_TOKENS.map((t) => t.value).join(" | "),
      },
    });
    // Drain the NDJSON file the logger wrote.
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(root);
    const ndjson = files.find((f) => f.endsWith(".ndjson"));
    assert.ok(ndjson, `expected an NDJSON file, got ${JSON.stringify(files)}`);
    const text = await readFile(path.join(root, ndjson!), "utf8");
    const records = text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));

    const { records: scrubbed, failedCanaries } = scrubBundle(records, {
      canaries: PLANTED_TOKENS,
      extraAllowedFields: ["at", "level", "source", "event", "fields", "hostId", "message", "correlationId", "retentionClass"],
    });

    assert.deepEqual(failedCanaries, []);
    assert.equal(scrubbed.length, records.length);
    // Every scrubbed record must NOT carry a planted canary literal.
    const bundleJson = JSON.stringify(scrubbed);
    for (const token of PLANTED_TOKENS) {
      assert.equal(
        bundleJson.includes(token.value),
        false,
        `canary ${token.name} (${token.value}) escaped scrubbing`,
      );
    }
  } finally { await cleanup(); }
});

test("default canary patterns detect secrets that slipped into a free-form message", () => {
  const text = [
    "private key:",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "aws: AKIAIOSFODNN7EXAMPLE",
    "gh: ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "home: /home/alice/projects/secret",
    "hex: 0123456789abcdef0123456789abcdef",
    "bearer: Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ].join("\n");
  const hits = detectCanaryPatterns(text);
  for (const token of PLANTED_TOKENS) {
    assert.equal(hits.includes(token.name), true, `expected ${token.name} to be detected`);
  }
});

test("a canary that the reviewer never declared is not scrubbed", () => {
  // The canary pass only scrubs tokens the reviewer EXPLICITLY
  // plants via the `canaries` option. A secret that the reviewer
  // didn't anticipate will pass through the scrubber — that's the
  // "no universal redaction guarantee" disclosure. The test asserts
  // that a literal the scrubber wasn't told about is NOT replaced,
  // and that the audit surface correctly reports no match.
  const records = [
    {
      at: new Date().toISOString(),
      level: "info",
      source: "test",
      event: "leak",
      message: "totally-unanticipated-token-9aa31be9",
    },
  ];
  const planted = [{ name: "reviewer-marker", value: "DIFFERENT-TOKEN-WHICH-IS-NOT-PRESENT" }];
  const { records: scrubbed, failedCanaries } = scrubBundle(records, {
    canaries: planted,
  });
  assert.equal(failedCanaries.length, 1);
  assert.equal(failedCanaries[0], "reviewer-marker");
  // The unanticipated literal survives — the scrubber never
  // claimed it would scrub it.
  assert.equal(
    JSON.stringify(scrubbed[0].scrubbed).includes("totally-unanticipated-token-9aa31be9"),
    true,
  );
});

test("canary replacement recurses into nested objects (M9.4 fix)", () => {
  // M9.4 documented the scrubber's nested-object limit and the
  // diagnostics-export pipeline relies on it. After the recursive
  // canary pass, a canary planted deep inside the record is
  // replaced with `[CANARY]` and removed from the audit surface.
  const records = [
    {
      at: new Date().toISOString(),
      level: "info",
      source: "test",
      event: "deep-leak",
      fields: { hostId: "DEEP-NESTED-CANARY-X1Y2Z3" },
    },
  ];
  const planted = [{ name: "deep", value: "DEEP-NESTED-CANARY-X1Y2Z3" }];
  const { records: scrubbed, failedCanaries } = scrubBundle(records, {
    canaries: planted,
    extraAllowedFields: ["at", "level", "source", "event", "fields"],
  });
  assert.deepEqual(failedCanaries, []);
  assert.equal(
    JSON.stringify(scrubbed[0].scrubbed).includes("DEEP-NESTED-CANARY-X1Y2Z3"),
    false,
  );
  assert.equal(
    JSON.stringify(scrubbed[0].scrubbed).includes("[CANARY]"),
    true,
  );
});

test("protected entries survive scrubbing and are reported as retentionPreserved: true", async () => {
  const { root, logger, cleanup } = await fixtureLogger();
  try {
    await logger.write({
      level: "info",
      source: "test",
      event: "protected-write",
      retentionClass: "pending-decision",
      fields: { hostId: "host-1", message: "must keep" },
    });
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(root);
    const ndjson = files.find((f) => f.endsWith(".ndjson"))!;
    const records = (await readFile(path.join(root, ndjson), "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const { records: scrubbed } = scrubBundle(records, {
      canaries: [],
      retentionClassesByIndex: ["pending-decision"],
    });
    assert.equal(scrubbed[0].report.retentionPreserved, true);
  } finally { await cleanup(); }
});

test("operational entries are reported as retentionPreserved: false", async () => {
  const { root, logger, cleanup } = await fixtureLogger();
  try {
    await logger.write({
      level: "info",
      source: "test",
      event: "ops",
      fields: { hostId: "host-1", message: "operational" },
    });
    const { readdir, readFile } = await import("node:fs/promises");
    const files = await readdir(root);
    const ndjson = files.find((f) => f.endsWith(".ndjson"))!;
    const records = (await readFile(path.join(root, ndjson), "utf8"))
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
    const { records: scrubbed } = scrubBundle(records, { canaries: [] });
    assert.equal(scrubbed[0].report.retentionPreserved, false);
  } finally { await cleanup(); }
});
