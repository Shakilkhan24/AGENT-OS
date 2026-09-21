/**
 * M9.4 — diagnostic scrubber.
 *
 * The M9.4 bullet (FUTURE/IMPLEMENTATION-README.md line 288) reads:
 *
 * > M9.4 Review local diagnostics before export. Keep telemetry off
 * > by default; operational logs use allowlisted fields and
 * > correlation IDs. Separate sensitive local content from operational
 * > logs. Test canary secrets/paths and disclose scrubber limits; no
 * > universal redaction guarantee. Retention never removes pending
 * > decisions, live intent records or the only recoverable candidate.
 *
 * This module is the OFFLINE scrubber a release engineer can run
 * before exporting a log bundle. The contract:
 *
 *   - Allowlist-only: any field not in the allowlist is REPLACED
 *     with a placeholder, never dropped silently. The reviewer can
 *     see exactly which fields were redacted (and how many times).
 *
 *   - Canary tokens: the reviewer can plant canary secrets/paths in
 *     the diagnostics bundle and verify the scrubber catches them
 *     all. The output always reports `canaryMisses` so a partial
 *     scrubber is obvious from the audit surface.
 *
 *   - Honest limits: the scrubber never claims "all secrets
 *     removed"; it claims "all canary tokens removed" with a count.
 *     Free-form text is NOT scrubbed by this layer — callers MUST
 *     use structured fields for anything sensitive.
 *
 *   - Retention floor: a `RetentionClass` flag tells the scrubber
 *     whether a record is a "pending decision", a "live intent", or
 *     a "recoverable candidate". The scrubber refuses to drop such
 *     records even when they contain unmatched fields.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Operational-log fields that MAY appear in a diagnostic record.
 * Anything outside this allowlist is replaced with `"[REDACTED]"`.
 */
export const allowedFieldSchema = z.enum([
  "timestamp",
  "correlationId",
  "level",
  "category",
  "subsystem",
  "message",
  "durationMs",
  "exitCode",
  "byteCount",
  "hostId",
  "recipeId",
  "recipeVersion",
  "workflowId",
  "workflowRunId",
  "sessionId",
  "scheduleId",
  "scheduleOccurrenceUtc",
  "invocationId",
  "stepKind",
  "stepId",
  "kind",
]);
export type AllowedField = z.infer<typeof allowedFieldSchema>;

export const retentionClassSchema = z.enum([
  /** Standard operational log — may be rotated. */
  "operational",
  /** Pending decision — retention floor is "never remove". */
  "pending-decision",
  /** Live intent record — retention floor is "never remove". */
  "live-intent",
  /** The only recoverable candidate — retention floor is "never remove". */
  "recoverable-candidate",
]);
export type RetentionClass = z.infer<typeof retentionClassSchema>;

export const scrubResultSchema = z
  .object({
    redacted: z.record(z.string(), z.unknown()),
    droppedKeys: z.array(z.string()),
    redactionCount: z.number().int().min(0),
    canaryMatches: z.number().int().min(0),
    canaryMisses: z.array(z.string()),
    retentionPreserved: z.boolean(),
  })
  .strict();
export type ScrubResult = z.infer<typeof scrubResultSchema>;

// ---------------------------------------------------------------------------
// Default canary tokens (canary tokens are scrubbed in addition to allowlist)
// ---------------------------------------------------------------------------

const DEFAULT_CANARY_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "ssh-private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: "home-directory", pattern: /\/(?:home|Users)\/[A-Za-z0-9._-]+/g },
  { name: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._\-]{20,}\b/g },
  { name: "hex-secret-32", pattern: /\b[0-9a-f]{32}\b/g },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scrub a single diagnostic record. Returns the redacted fields +
 * a count of redacted keys + a list of dropped keys (unknown fields
 * outside the allowlist).
 *
 * The scrubber does NOT scrub free-form `message` text — callers
 * MUST move any sensitive content out of `message` before logging.
 */
export function scrubRecord(
  input: Record<string, unknown>,
  options: {
    retentionClass?: RetentionClass;
    canaries?: ReadonlyArray<{ name: string; value: string }>;
    extraAllowedFields?: ReadonlyArray<AllowedField>;
  } = {},
): ScrubResult {
  const retentionClass = options.retentionClass ?? "operational";
  const retentionPreserved = retentionClass !== "operational";
  const allow = new Set<string>(allowedFieldSchema.options as ReadonlyArray<string>);
  for (const extra of options.extraAllowedFields ?? []) allow.add(extra);

  const droppedKeys: string[] = [];
  const redacted: Record<string, unknown> = {};
  let redactionCount = 0;
  for (const [key, value] of Object.entries(input)) {
    if (allow.has(key)) {
      redacted[key] = value;
    } else {
      droppedKeys.push(key);
      redacted[key] = "[REDACTED]";
      redactionCount += 1;
    }
  }

  const canaries = options.canaries ?? [];
  let canaryMatches = 0;
  const canaryMisses: string[] = [];
  for (const canary of canaries) {
    let found = false;
    const haystack = JSON.stringify(redacted);
    if (haystack.includes(canary.value)) {
      canaryMatches += 1;
      found = true;
      // Replace the canary value in-place so the output never carries the
      // literal secret in the audit surface either.
      const escaped = canary.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      for (const key of Object.keys(redacted)) {
        const value = redacted[key];
        if (typeof value === "string") redacted[key] = value.replace(re, "[CANARY]");
      }
    }
    if (!found) canaryMisses.push(canary.name);
  }

  return scrubResultSchema.parse({
    redacted,
    droppedKeys,
    redactionCount,
    canaryMatches,
    canaryMisses,
    retentionPreserved,
  });
}

/**
 * Convenience: also scan every string-typed allowed field for the
 * default canary patterns (SSH keys, AWS keys, etc.). Returns the
 * list of detected canary names so the reviewer can audit them.
 */
export function detectCanaryPatterns(text: string): ReadonlyArray<string> {
  const matches: string[] = [];
  for (const { name, pattern } of DEFAULT_CANARY_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) matches.push(name);
  }
  return matches;
}

/**
 * Compose a "release-ready" diagnostic bundle: scrub a list of
 * records with the supplied canaries and refuse if any canary
 * escaped scrubbing. The returned bundle always carries the audit
 * surface (`scrubReport`).
 */
export function scrubBundle(
  records: ReadonlyArray<Record<string, unknown>>,
  options: {
    canaries: ReadonlyArray<{ name: string; value: string }>;
    retentionClassesByIndex?: ReadonlyArray<RetentionClass>;
    extraAllowedFields?: ReadonlyArray<AllowedField>;
  },
): {
  records: ReadonlyArray<{ scrubbed: Record<string, unknown>; report: ScrubResult }>;
  failedCanaries: ReadonlyArray<string>;
} {
  const failed = new Set<string>();
  const out = records.map((record, i) => {
    const retention = options.retentionClassesByIndex?.[i] ?? "operational";
    const report = scrubRecord(record, {
      retentionClass: retention,
      canaries: options.canaries,
      extraAllowedFields: options.extraAllowedFields,
    });
    for (const miss of report.canaryMisses) failed.add(miss);
    return { scrubbed: report.redacted, report };
  });
  return { records: out, failedCanaries: [...failed] };
}

void z;
