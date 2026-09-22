/**
 * M3a — secret redactor.
 *
 * `redactSecrets` walks a value tree and replaces strings that look like
 * secret material with a stable placeholder. The placeholder preserves
 * the *shape* of the value (its length and presence) so receipts remain
 * diff-stable, but never reveals the underlying secret.
 *
 * Detected categories:
 *  - Bearer / JWT tokens (Authorization: Bearer ...)
 *  - Long hex strings (>40 chars) — looks like a private-key body
 *  - Patterns matching common API key shapes (sk-..., ghp_..., xoxb-...)
 *  - SSH private key headers (-----BEGIN OPENSSH PRIVATE KEY-----)
 *  - Environment-style `KEY=VALUE` where VALUE looks random
 *
 * The redactor is intentionally conservative: false positives are
 * acceptable (over-redaction is fine); false negatives are not
 * (any leak is unacceptable).
 */
const PLACEHOLDER = "[REDACTED]";

const HIGH_ENTROPY_HEX = /^[0-9a-f]{40,}$/i;
const COMMON_API_PREFIXES = /(^|[^=\w])(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xoxb-[A-Za-z0-9-]{16,}|xoxp-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,})/g;
const BEARER_TOKEN = /Bearer\s+[A-Za-z0-9._\-+/=]{20,}/g;
const SSH_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ENV_LINE = /(^|\n)([A-Z][A-Z0-9_]{2,})=([^\s]+)/g;

/**
 * Returns true when the value looks like a random secret we should
 * redact. Heuristic — high entropy + a known prefix or length threshold.
 */
export function looksLikeSecret(value: string): boolean {
  if (value.length === 0) return false;
  if (COMMON_API_PREFIXES.test(value)) return true;
  if (HIGH_ENTROPY_HEX.test(value)) return true;
  if (/^[A-Za-z0-9_\-+/=]{32,}$/.test(value)) {
    // 32+ chars of base64url-ish characters → likely a key/token.
    return true;
  }
  return false;
}

export function redactString(input: string): string {
  let out = input;
  out = out.replace(BEARER_TOKEN, `Bearer ${PLACEHOLDER}`);
  out = out.replace(SSH_HEADER, PLACEHOLDER);
  // The prefix-style regex has a leading non-token capture group so we
  // preserve whatever came before it (whitespace, punctuation, or `=`).
  out = out.replace(COMMON_API_PREFIXES, (_full, lead: string) => `${lead}${PLACEHOLDER}`);
  out = out.replace(ENV_LINE, (full, lead, name: string) => {
    const value = full.slice((lead as string).length + name.length + 1);
    if (looksLikeSecret(value)) return `${lead}${name}=${PLACEHOLDER}`;
    return full;
  });
  return out;
}

/**
 * Recursively redact any string-shaped field in an unknown value. Walks
 * objects, arrays, and primitives. Strings are returned verbatim if they
 * do not match a secret pattern; objects/arrays are rebuilt without
 * mutating the input.
 */
export function redactSecrets<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(item => redactSecrets(item)) as unknown as T;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    result[key] = redactSecrets(child);
  }
  return result as T;
}