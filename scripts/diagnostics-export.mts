#!/usr/bin/env node
/**
 * M9.4 — diagnostics export pipeline.
 *
 * Usage:
 *   npx tsx scripts/diagnostics-export.mts <data-dir> [--out <out-dir>] [--canary <name=token> ...]
 *
 * Walks every NDJSON log file under `<data-dir>/logs/`, runs the
 * allowlist+canary scrubber from `src/release/diagnostic-scrubber.ts`
 * over each record, and emits:
 *
 *   - `<out-dir>/diagnostics-<timestamp>.ndjson` — one line per record
 *     (`scrubbed` + `report`).
 *   - `<out-dir>/scrub-report.json` — aggregate audit surface.
 *
 * Exit codes:
 *   0  — clean: no canary escaped, at least one record was processed.
 *   1  — at least one canary token was NOT scrubbed (reviewer must inspect).
 *   2  — no records found in `<data-dir>/logs/`.
 *
 * The script never claims "all secrets removed". It claims "all canary
 * tokens removed" with a count. Free-form text in the `message` field
 * is not scrubbed by this layer — see `docs/diagnostics.md`.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  scrubBundle,
  detectCanaryPatterns,
  type RetentionClass,
} from "../src/release/diagnostic-scrubber";

/** CLI flag parser — kept small on purpose. */
function parseArgs(argv: ReadonlyArray<string>): {
  dataDir: string;
  outDir: string;
  canaries: ReadonlyArray<{ name: string; value: string }>;
} {
  let dataDir: string | undefined;
  let outDir = path.join(process.cwd(), "diagnostics-out");
  const canaries: Array<{ name: string; value: string }> = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a value");
      outDir = next;
    } else if (arg === "--canary") {
      const next = argv[++i];
      if (!next) throw new Error("--canary requires name=token");
      const eq = next.indexOf("=");
      if (eq <= 0) throw new Error(`--canary expects name=token (got "${next}")`);
      canaries.push({ name: next.slice(0, eq), value: next.slice(eq + 1) });
    } else if (dataDir) {
      throw new Error(`Unexpected positional arg "${arg}"`);
    } else {
      dataDir = arg;
    }
  }
  if (!dataDir) throw new Error("Usage: diagnostics-export.mts <data-dir> [--out <out-dir>] [--canary name=token ...]");
  return { dataDir, outDir, canaries };
}

/**
 * Build the default reviewer canary. A unique, easily-greppable token
 * that the reviewer can plant into a log entry; if the bundle file
 * still contains it after scrubbing, the scrubber refused to scrub
 * the bundle itself.
 */
const DEFAULT_REVIEWER_CANARY = { name: "reviewer-marker", value: "MINIMAL-CANARY-9aa31be9" };

export interface DiagnosticsExportInput {
  dataDir: string;
  outDir: string;
  canaries?: ReadonlyArray<{ name: string; value: string }>;
}

export interface DiagnosticsExportResult {
  exitCode: 0 | 1 | 2;
  totalRecords: number;
  redactionCount: number;
  canaryMatches: number;
  failedCanaries: ReadonlyArray<string>;
  perClassCounts: Readonly<Record<RetentionClass, number>>;
  bundlePath: string;
  reportPath: string;
}

/** Internal seam used by tests to drive the export logic without spawning a subprocess. */
export async function runDiagnosticsExport(
  input: DiagnosticsExportInput,
): Promise<DiagnosticsExportResult> {
  const allCanaries = [DEFAULT_REVIEWER_CANARY, ...(input.canaries ?? [])];
  const logDir = path.join(input.dataDir, "logs");
  const records: Array<Record<string, unknown>> = [];
  const retentionByIndex: RetentionClass[] = [];
  // Walk both desktop and runtime log directories.
  const roots: string[] = [];
  try {
    await readdir(logDir);
    roots.push(logDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const runtimeLogDir = path.join(logDir, "runtime");
  try {
    await readdir(runtimeLogDir);
    roots.push(runtimeLogDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const root of roots) {
    for (const file of await readdir(root)) {
      if (!/\.ndjson$/.test(file)) continue;
      const text = await readFile(path.join(root, file), "utf8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          records.push(parsed);
          const cls = (parsed.retentionClass ?? "operational") as RetentionClass;
          retentionByIndex.push(cls);
        } catch {
          // Skip unparseable lines — the in-process scrubber already
          // redacted the line; a parse failure here is a reviewer
          // signal recorded in the per-record report.
          records.push({ unparseable: line.slice(0, 256) });
          retentionByIndex.push("operational");
        }
      }
    }
  }
  if (!records.length) {
    await mkdir(input.outDir, { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      totalRecords: 0,
      redactionCount: 0,
      canaryMatches: 0,
      failedCanaries: [],
      perClassCounts: { operational: 0, "pending-decision": 0, "live-intent": 0, "recoverable-candidate": 0 },
      reason: "no-records",
    };
    await writeFile(path.join(input.outDir, "scrub-report.json"), JSON.stringify(report, null, 2));
    return {
      exitCode: 2,
      totalRecords: 0,
      redactionCount: 0,
      canaryMatches: 0,
      failedCanaries: [],
      perClassCounts: report.perClassCounts,
      bundlePath: "",
      reportPath: path.join(input.outDir, "scrub-report.json"),
    };
  }

  const { records: scrubbed, failedCanaries } = scrubBundle(records, {
    canaries: allCanaries,
    retentionClassesByIndex: retentionByIndex,
  });

  // Aggregate audit surface.
  let totalRedactions = 0;
  let totalCanaryMatches = 0;
  const perClassCounts: Record<RetentionClass, number> = {
    operational: 0,
    "pending-decision": 0,
    "live-intent": 0,
    "recoverable-candidate": 0,
  };
  for (let i = 0; i < scrubbed.length; i += 1) {
    const report = scrubbed[i].report;
    totalRedactions += report.redactionCount;
    totalCanaryMatches += report.canaryMatches;
    const cls = retentionByIndex[i] ?? "operational";
    perClassCounts[cls] = (perClassCounts[cls] ?? 0) + 1;
  }

  await mkdir(input.outDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bundlePath = path.join(input.outDir, `diagnostics-${timestamp}.ndjson`);
  const bundleLines = scrubbed.map(({ scrubbed: s, report }) =>
    JSON.stringify({ scrubbed: s, report }),
  );
  await writeFile(bundlePath, bundleLines.join("\n") + "\n");
  const aggregate = {
    generatedAt: new Date().toISOString(),
    totalRecords: records.length,
    redactionCount: totalRedactions,
    canaryMatches: totalCanaryMatches,
    failedCanaries: [...failedCanaries],
    perClassCounts,
    defaultCanaryHits: detectCanaryPatterns(bundleLines.join("\n")),
  };
  const reportPath = path.join(input.outDir, "scrub-report.json");
  await writeFile(reportPath, JSON.stringify(aggregate, null, 2));

  const exitCode: 0 | 1 = failedCanaries.length > 0 ? 1 : 0;
  return {
    exitCode,
    totalRecords: records.length,
    redactionCount: totalRedactions,
    canaryMatches: totalCanaryMatches,
    failedCanaries: [...failedCanaries],
    perClassCounts,
    bundlePath,
    reportPath,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { dataDir, outDir, canaries } = parseArgs(process.argv.slice(2));
    const result = await runDiagnosticsExport({ dataDir, outDir, canaries });
    process.stdout.write(
      `processed ${result.totalRecords} record(s); redactions=${result.redactionCount}; canaryMatches=${result.canaryMatches}; failedCanaries=${result.failedCanaries.length}\n`,
    );
    process.stdout.write(`bundle: ${result.bundlePath || "(none)"}\n`);
    process.stdout.write(`report: ${result.reportPath}\n`);
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`diagnostics-export: ${(error as Error).message ?? String(error)}\n`);
    process.exit(2);
  }
}
