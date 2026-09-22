/**
 * M4.6.a — context-source import.
 *
 * The M4.3 catalog surfaces `AGENTS.md` / `CLAUDE.md` /
 * `.cursorrules` / `README.md` / `CONTRIBUTING.md` / `*.instructions.md`
 * as `context-source` capabilities but does not actually pin their
 * bytes into the receipt ledger. M4.6.a closes that gap.
 *
 * `importContextSource` records an audit row in the meta table keyed
 * `context-import:<runId>:<source.digest>`. The key is
 * content-addressed so re-importing the identical source bytes for the
 * same run collapses to a single row (mirrors the M4.5 snapshot rule).
 *
 * Trust rules:
 *  - The supplied `source.kind` MUST equal `"context-source"`. A
 *    typo / future kind never lands in the receipt ledger.
 *  - When `source.content` is provided the function re-derives
 *    `sha256(source.content)` and refuses a mismatch with
 *    `source.digest` via `CONFLICT`. A reviewer can verify the
 *    pin without trusting the caller.
 *  - The `runId` MUST resolve to an existing run row; otherwise
 *    `NOT_FOUND`.
 *  - The audit row's `payloadDigest` is SHA-256 over the canonical
 *    payload (excluding itself). Identical re-imports yield identical
 *    digests so a renderer can dedupe without trust.
 *
 * The imported record carries `sourceId` (the M4.3 catalog's
 * `capabilityId`), `origin`, `digest`, `bytes`, `importedAt`, and
 * `importedBy`. The receipt path can stamp `importDigest` on the run
 * later — M4.6.a only owns the import row.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError } from "../../shared/errors";
import type { DbWorker } from "./worker";
import { stableStringify } from "./effective-settings";

export const CONTEXT_IMPORT_META_PREFIX = "context-import:";

export const contextImportRecordSchema = z
  .object({
    runId: z.string().uuid(),
    sourceId: z.string().uuid(),
    origin: z.string().min(1).max(512),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
    importedAt: z.string().datetime(),
    importedBy: z.string().min(1).max(256),
    payloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type ContextImportRecord = z.infer<typeof contextImportRecordSchema>;

interface DriverRaw {
  prepare(sql: string): {
    run(...b: unknown[]): void;
    first(...b: unknown[]): Record<string, unknown> | undefined;
    all(...b: unknown[]): Array<Record<string, unknown>>;
  };
}
function driverOf(worker: DbWorker): DriverRaw {
  return (worker as unknown as { driver: DriverRaw }).driver;
}

const importInputSchema = z
  .object({
    taskId: z.string().uuid(),
    runId: z.string().uuid(),
    source: z
      .object({
        capabilityId: z.string().uuid(),
        kind: z.literal("context-source"),
        origin: z.string().min(1).max(512),
        digest: z.string().regex(/^[0-9a-f]{64}$/),
        bytes: z.number().int().nonnegative(),
        content: z.string().max(1024 * 1024).optional(),
      })
      .strict(),
    importedBy: z.string().min(1).max(256),
  })
  .strict();

/**
 * Record a context-source import against a run. Writes a content-addressed
 * audit row under `context-import:<runId>:<digest>` and returns the
 * parsed record.
 *
 * Errors:
 *  - `INVALID_REQUEST` — bad shape, mismatched bytes, mismatched kind.
 *  - `CONFLICT` — supplied `content` re-derived digest disagrees with
 *    `source.digest` (the pin cannot be silently rewritten).
 *  - `NOT_FOUND` — `runId` does not resolve to an existing run row.
 */
export async function importContextSource(
  worker: DbWorker,
  input: z.input<typeof importInputSchema>,
): Promise<ContextImportRecord> {
  let parsed: z.infer<typeof importInputSchema>;
  try {
    parsed = importInputSchema.parse(input);
  } catch (error) {
    throw new AppError(
      "INVALID_REQUEST",
      `Context-source import input is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Cross-field validation: if content is supplied it must hash to the
  // declared digest AND its byte length must equal `bytes`.
  if (parsed.source.content !== undefined) {
    const reDerived = createHash("sha256").update(parsed.source.content, "utf8").digest("hex");
    if (reDerived !== parsed.source.digest) {
      throw new AppError(
        "CONFLICT",
        `Source digest mismatch: declared ${parsed.source.digest} ≠ re-derived ${reDerived}`,
      );
    }
    const measuredBytes = Buffer.byteLength(parsed.source.content, "utf8");
    if (measuredBytes !== parsed.source.bytes) {
      throw new AppError(
        "INVALID_REQUEST",
        `Source bytes mismatch: declared ${parsed.source.bytes} ≠ measured ${measuredBytes}`,
      );
    }
  }
  const driver = driverOf(worker);
  const runExists = driver.prepare(`SELECT uuid FROM run WHERE uuid = ?`).first(parsed.runId);
  if (!runExists) throw new AppError("NOT_FOUND", `Run ${parsed.runId} not found`);
  const importedAt = new Date().toISOString();
  // Compute the payload digest over the canonical payload EXCLUDING
  // `importedAt`. The timestamp is recorded for audit but does NOT
  // participate in identity: identical re-imports (same source bytes
  // + same runId + same actor) must produce identical digests. The
  // meta row is keyed by `<runId>:<source.digest>` so an identical
  // re-import collapses to one row via INSERT OR REPLACE; the
  // digest matches even though the timestamp advances.
  const canonical = {
    runId: parsed.runId,
    sourceId: parsed.source.capabilityId,
    origin: parsed.source.origin,
    digest: parsed.source.digest,
    bytes: parsed.source.bytes,
    importedBy: parsed.importedBy,
  };
  const payloadDigest = createHash("sha256")
    .update(stableStringify({ ...canonical, payloadDigest: "" }), "utf8")
    .digest("hex");
  const record: ContextImportRecord = contextImportRecordSchema.parse({
    ...canonical,
    importedAt,
    payloadDigest,
  });
  driver
    .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
    .run(importKey(parsed.runId, parsed.source.digest), JSON.stringify(record));
  return record;
}

/** Test seam: build the meta key for a context-import audit row. */
export function importKey(runId: string, digest: string): string {
  return `${CONTEXT_IMPORT_META_PREFIX}${runId}:${digest}`;
}

/**
 * List import audit rows for a run, in `importedAt` ascending order.
 * Useful for the bounded memory view (session / task).
 */
export function listContextImportsForRun(
  worker: DbWorker,
  runId: string,
): ContextImportRecord[] {
  const driver = driverOf(worker);
  const prefix = `${CONTEXT_IMPORT_META_PREFIX}${runId}:`;
  const rows = driver.prepare(`SELECT key, value FROM meta`).all();
  const out: ContextImportRecord[] = [];
  for (const row of rows) {
    const key = String(row.key ?? "");
    if (!key.startsWith(prefix)) continue;
    const raw = String(row.value ?? "");
    if (!raw) continue;
    try {
      out.push(contextImportRecordSchema.parse(JSON.parse(raw)));
    } catch {
      // Skip malformed rows silently — listing must not throw.
    }
  }
  return out.sort((a, b) => (a.importedAt < b.importedAt ? -1 : a.importedAt > b.importedAt ? 1 : 0));
}
