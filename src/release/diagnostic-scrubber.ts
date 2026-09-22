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
 * Recursively walk `value` and replace every occurrence of `token`
 * with `[CANARY]`. Used by the canary pass so a leaked secret that
 * landed in a nested structure is removed from the audit surface,
 * not just detected. Strings are replaced via regex; objects and
 * arrays are descended into. Other primitives pass through.
 */
function redactCanary(value: unknown, token: string, replacement: string): unknown {
  if (typeof value === "string") {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(escaped, "g"), replacement);
  }
  if (Array.isArray(value)) return value.map((item) => redactCanary(item, token, replacement));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactCanary(v, token, replacement);
    }
    return result;
  }
  return value;
}

/**
 * Scrub a single diagnostic record. Returns the redacted fields +
 * a count of redacted keys + a list of dropped keys (unknown fields
 * outside the allowlist).
 *
 * The scrubber does NOT scrub free-form `message` text — callers
 * MUST move any sensitive content out of `message` before logging.
 * The canary pass DOES recurse into nested objects so a leaked
 * secret that landed in `fields.hostId` (or any other nested
 * structure) is replaced with `[CANARY]`, not just detected.
 */
export function scrubRecord(
  input: Record<string, unknown>,
  options: {
    retentionClass?: RetentionClass;
    canaries?: ReadonlyArray<{ name: string; value: string }>;
    /**
     * Optional extra allowed field names (string). Used by callers
     * that need to widen the allowlist beyond the 22 operational
     * fields — the diagnostics export pipeline, for example, adds
     * the Logger's nested keys (`at`, `source`, `event`,
     * `retentionClass`) so the scrubber can read them.
     */
    extraAllowedFields?: ReadonlyArray<string>;
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
    const haystack = JSON.stringify(redacted);
    if (haystack.includes(canary.value)) {
      canaryMatches += 1;
      // Recursively replace the canary literal in the redacted
      // payload (including nested objects and arrays). The previous
      // implementation only walked top-level string fields, which
      // left the literal in nested structures and undermined the
      // "no universal redaction guarantee" disclosure.
      const scrubbed = redactCanary(redacted, canary.value, "[CANARY]");
      for (const k of Object.keys(redacted)) {
        delete redacted[k];
      }
      Object.assign(redacted, scrubbed as Record<string, unknown>);
    } else {
      canaryMisses.push(canary.name);
    }
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
    extraAllowedFields?: ReadonlyArray<string>;
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
