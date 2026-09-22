# Diagnostics, telemetry, and the scrubber contract

This document describes the M9.4 diagnostic posture: telemetry
defaults, the three scrubbers MINIMAL ships, the retention floor,
the canary taxonomy, and how to run an offline bundle export.

## TL;DR

- **Telemetry is off by default.** `settings.telemetry` is
  `false` unless the user (or a future M-bullet) flips it. No
  uploader ships in this release. The renderer Content-Security
  Policy (`connect-src 'none'`, see `src/renderer/index.html:5`)
  blocks any future inadvertent destination.
- **Operational logs are allowlisted.** The offline scrubber
  replaces any field outside its 22-key allowlist with
  `[REDACTED]`; the count is surfaced on the audit surface.
- **Two scrubbers, distinct roles.** `src/main/logging.ts:scrub`
  is the cheap in-process keyword scrubber for hot-path
  observability. `src/release/diagnostic-scrubber.ts:scrubRecord`
  / `scrubBundle` is the offline allowlist+canary scrubber the
  export pipeline runs before any bundle is written.
- **No universal redaction guarantee.** The scrubber never claims
  "all secrets removed"; it claims "all canary tokens removed"
  with a count. Reviewers plant canaries they know about.
- **Retention floor.** `pending-decision`, `live-intent`, and
  `recoverable-candidate` entries are NEVER dropped by the
  day-rollover purge or the event-journal hard cap. Operational
  entries are bounded by `logRetentionDays` (default 7, max 30)
  and `eventReplayLimit` (default 1000, max 5000).

## Telemetry default

```ts
// src/shared/settings.ts
telemetry: z.boolean().default(false),
```

`KNOWN_SETTING_KEYS` in `src/runtime/db/effective-settings.ts`
mirrors the field. The flag ships dormant — it exists so a future
M-bullet can wire a destination without schema churn. No
production code reads `settings.telemetry` today.

The renderer Content-Security-Policy is:

```
default-src 'self'; script-src 'self'; style-src 'self';
  connect-src 'none'; font-src 'self'; img-src 'self' data:;
  object-src 'none'; base-uri 'self'; frame-ancestors 'none';
```

`connect-src 'none'` blocks every form of renderer-initiated
network egress. See `tests/desktop/telemetry-csp.test.ts` for the
test that locks this at the source (after build).

## The three scrubbers

### 1. `src/main/logging.ts:scrub` — hot-path keyword scrubber

Applied to every `log()` callsite. Redacts a value when its key
matches:

```
/command|content|password|secret|token|clipboard|environment|^env$|^data$/i
```

The scrubber is bounded (depth 4, array length 32, string length
1024 chars) so a malicious log payload can't allocate unbounded
memory. It DOES NOT recognise:
- Home-directory paths (e.g. `/home/alice/...`).
- AWS access keys (`AKIA...`).
- SSH private keys (`-----BEGIN ... PRIVATE KEY-----`).
- GitHub / bearer / API-prefix tokens.
- 32-char hex secrets.
- `env`-line shapes (`KEY=value`).

Callers that handle those values use the M3a walker
(`src/runtime/db/redact.ts:redactSecrets`), which carries the wider
pattern set.

### 2. `src/release/diagnostic-scrubber.ts` — offline allowlist scrubber

Applied by `scripts/diagnostics-export.mts`. The allowlist of 22
operational fields:

```
timestamp, correlationId, level, category, subsystem, message,
durationMs, exitCode, byteCount, hostId, recipeId, recipeVersion,
workflowId, workflowRunId, sessionId, scheduleId,
scheduleOccurrenceUtc, invocationId, stepKind, stepId, kind
```

Anything outside this list is REPLACED with `[REDACTED]`, never
dropped silently. The replacement count surfaces on the per-record
report and the aggregate audit report.

The canary pass RECURSES into nested objects/arrays, so a leaked
secret that lands in `fields.hostId` (or any other nested
structure) is REPLACED with `[CANARY]`, not just detected.

The scrubber does NOT scrub free-form `message` text — callers
MUST move any sensitive content out of `message` before logging.
The canary pass catches leaks into `message` after the fact.

### 3. `src/runtime/db/redact.ts` — runtime secret walker (M3a)

Used in M3a context receipts. Patterns:
- `BEARER_TOKEN` — `Bearer <token>`.
- `SSH_HEADER` — `-----BEGIN ... PRIVATE KEY-----`.
- `COMMON_API_PREFIXES` — `sk-`, `ghp_`, `xoxb-`, etc.
- `ENV_LINE` — `KEY=value` at line start.
- `HIGH_ENTROPY_HEX` — 40-char hex secrets.

Pattern overlap with the diagnostic scrubber is intentional: the
M3a walker is the runtime redaction layer, the diagnostic
scrubber is the offline review layer. Future M-bullets that add
new secret patterns must update BOTH (or provide a shared helper).

## Scrubber limits (disclosed honestly)

The runtime never claims a universal redaction guarantee. Specific
known limits:

- **Free-form `message` text.** The diagnostic scrubber passes
  `message` through verbatim. Callers MUST NOT log secrets into
  `message`. The canary pass catches leaks but does not scrub
  free-form text.
- **Hot-path scrubber blind spots.** Listed under
  `src/main/logging.ts:scrub` above. Callers MUST handle
  home-directory paths, AWS access keys, SSH private keys, etc.
  via `redactSecrets` BEFORE they reach `log()`.
- **Unknown canaries.** A canary the reviewer never declared is
  NOT scrubbed. Plant every secret type you care about via
  `--canary name=token`.
- **No cryptographic guarantee.** The canary scrubber matches
  tokens by literal string. A secret that has been split across
  fields, base64-encoded, or otherwise obscured will not match.
- **Nested-object replacement requires recursion.** Before M9.4,
  the diagnostic scrubber only replaced top-level string fields.
  M9.4 makes the canary pass recurse so nested canaries are
  replaced, but the replacement is still a string-literal match.

## Retention floor

`RetentionClass` is one of:

```
"operational"            — may be rotated
"pending-decision"       — retention floor: never remove
"live-intent"            — retention floor: never remove
"recoverable-candidate"  — retention floor: never remove
```

### Day-rollover purge (`src/main/logging.ts`)

`Logger.write` consults the entry's `retentionClass` before
appending. The day-rollover purge (`readdir` + `rm`) skips any
day file containing at least one non-operational entry.

A bounded cap (`MAX_PROTECTED_FILE_BYTES = 50 MiB`) refuses
further protected writes when the day's file would exceed it.
The refusal is logged as a separate operational entry
(`retention-floor-blocked`) so a reviewer can audit it.

A test seam (`Logger.applyRetentionClasses([...])`) lets a test
mark a day's entries as protected without restarting the logger.

### Event journal (`src/main/event-bus.ts`)

`EventBus.publishMany` slices the in-memory `events` array
class-aware:

- Operational events are bounded at `limit` (default 1000, max
  5000).
- Protected events (the three non-operational classes) are kept
  past the cap; the `protectedCount()` test seam surfaces the
  count.

The classification is per-`sourceId` and is derived from
`classifySourceForRetention()` in
[`src/release/compatibility-check.ts`](../src/release/compatibility-check.ts).
Defaults to `operational` for any source not on the allowlist:

| `sourceId` | `RetentionClass` |
|---|---|
| `runtime/dispatcher.decision` | `pending-decision` |
| `runtime/dispatcher.intent`   | `live-intent` |
| `runtime/backup.candidate`    | `recoverable-candidate` |
| anything else                 | `operational` |

Adding a new mapping is a deliberate, review-time decision.

## Default canary taxonomy

The diagnostic scrubber ships with six default canary patterns:

| Name | Pattern |
|---|---|
| `ssh-private-key` | `-----BEGIN [A-Z ]*PRIVATE KEY-----` |
| `aws-access-key` | `\bAKIA[0-9A-Z]{16}\b` |
| `github-token` | `\bgh[pousr]_[A-Za-z0-9]{36,255}\b` |
| `home-directory` | `\/(?:home\|Users)\/[A-Za-z0-9._-]+` |
| `bearer-token` | `\bBearer\s+[A-Za-z0-9._\-]{20,}\b` |
| `hex-secret-32` | `\b[0-9a-f]{32}\b` |

Reviewers can add more via `--canary name=token` on the export CLI.

`detectCanaryPatterns(text)` returns the names of default canary
patterns that match the input — useful for screening before the
export.

## How to export a bundle

```bash
# Writes diagnostics-<timestamp>.ndjson + scrub-report.json under <out-dir>.
npx tsx scripts/diagnostics-export.mts <data-dir> --out <out-dir> \
  --canary review-secret=PLANTED-TOKEN-9aa31be9 \
  --canary other-token=PLANTED-TOKEN-XYZ123
# Exits 0 on a clean bundle; 1 when any canary escaped; 2 when no records found.
```

The script refuses to exit 0 when a canary escaped — the reviewer
inspects `<out-dir>/scrub-report.json` and either tightens the
allowlist, adds the new pattern, or rewrites the offending log
call site.

## Operational logs and correlation IDs

Every operational log record carries:

- `at` — ISO-8601 timestamp.
- `level` — `info | warning | error`.
- `source` — subsystem name (`application`, `ipc`, `events`, …).
- `event` — short verb.
- `correlationId` — UUID; back-filled when missing
  (`src/main/logging.ts:63,83,92`).
- `retentionClass` — `operational` by default; explicit for
  protected entries.
- `fields` — payload; recursively scrubbed by `scrub()` before
  serialisation.

Callsites are expected to log only structured fields
(`{ method, code, bytes, durationMs, correlationId, … }`) — NEVER
paste contents, terminal output, file bytes, or any user-provided
content. This is the "sensitive local content is separate from
operational logs" discipline.

## How to verify the contract

```bash
# The end-to-end canary test plants all 6 tokens in a real Logger
# write, drains the NDJSON, runs scrubBundle, and asserts the audit
# surface reports zero missed canaries.
npx tsx --test tests/runtime/diagnostics-export.test.ts

# The day-rollover retention floor.
npx tsx --test tests/logging.test.ts

# The event-journal class-aware slicing.
npx tsx --test tests/runtime/event-bus-retention.test.ts

# The build-locked renderer CSP audit.
npx playwright test tests/desktop/telemetry-csp.test.ts
```

## Known follow-ups

- **M9.5 / M9.6** may wire a destination for `settings.telemetry`.
  When they do, they MUST inherit the renderer CSP (or relax it
  deliberately with a release-notes entry).
- The `redactCanary` recursion is a M9.4 fix; if a future M-bullet
  needs a different replacement strategy, the recursion contract
  is the seam to swap.
