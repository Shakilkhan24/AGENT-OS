#!/usr/bin/env node
/**
 * M9.5 — pilot runner CLI.
 *
 * Usage:
 *   npx tsx scripts/run-pilot.mts <charter.json> [options]
 *
 * Options:
 *   --fixtures-dir <dir>    Directory of *.fixture.json files
 *                           (default: tests/fixtures/pilot).
 *   --out <dir>             Output directory for attempts.ndjson +
 *                           pilot-report.json (default: pilot-out).
 *   --participants a,b,c    Override the charter's participantIds.
 *   --seed <hex>            Override the charter's seed.
 *   --synthetic             Run in synthetic mode (no real I/O).
 *   --canary name=token     Plant a canary token in every attempt.
 *
 * Exit codes:
 *   0  — clean: at least one attempt was produced and no refusal occurred.
 *   1  — at least one attempt was abandoned due to budget refusal.
 *   2  — no fixtures discovered (synthetic or real).
 *   3  — charter schema violation.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  pilotCharterSchema,
  fixtureSchema,
  type PilotCharter,
  type Fixture,
  type PilotCondition,
} from "../src/shared/pilot-schema";
import { runPilot } from "../src/runtime/pilot/runner";
import { rollAttempts } from "../src/runtime/pilot/aggregate";
import { pilotReportSchema } from "../src/shared/pilot-schema";

interface ParsedArgs {
  charterPath: string;
  fixturesDir: string;
  outDir: string;
  participants?: ReadonlyArray<string>;
  seed?: string;
  synthetic: boolean;
  canaries: ReadonlyArray<{ name: string; value: string }>;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  let charterPath: string | undefined;
  let fixturesDir = path.join(process.cwd(), "tests/fixtures/pilot");
  let outDir = path.join(process.cwd(), "pilot-out");
  let participants: string[] | undefined;
  let seed: string | undefined;
  let synthetic = false;
  const canaries: Array<{ name: string; value: string }> = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--fixtures-dir") {
      const next = argv[++i];
      if (!next) throw new Error("--fixtures-dir requires a value");
      fixturesDir = next;
    } else if (arg === "--out") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a value");
      outDir = next;
    } else if (arg === "--participants") {
      const next = argv[++i];
      if (!next) throw new Error("--participants requires a value");
      participants = next.split(",").map((s) => s.trim()).filter(Boolean);
    } else if (arg === "--seed") {
      const next = argv[++i];
      if (!next) throw new Error("--seed requires a value");
      seed = next;
    } else if (arg === "--synthetic") {
      synthetic = true;
    } else if (arg === "--canary") {
      const next = argv[++i];
      if (!next) throw new Error("--canary requires name=token");
      const eq = next.indexOf("=");
      if (eq <= 0) throw new Error(`--canary expects name=token (got "${next}")`);
      canaries.push({ name: next.slice(0, eq), value: next.slice(eq + 1) });
    } else if (arg === "--help" || arg === "-h") {
      throw new Error("help"); // surfaces the usage below
    } else if (charterPath) {
      throw new Error(`Unexpected positional arg "${arg}"`);
    } else {
      charterPath = arg;
    }
  }
  if (!charterPath) {
    throw new Error("Usage: run-pilot.mts <charter.json> [--fixtures-dir <dir>] [--out <dir>] [--synthetic]");
  }
  return { charterPath, fixturesDir, outDir, participants, seed, synthetic, canaries };
}

async function loadFixtures(dir: string): Promise<Fixture[]> {
  const files = (await readdir(dir).catch(() => [] as string[]))
    .filter((f) => /\.fixture\.json$/.test(f))
    .sort();
  const fixtures: Fixture[] = [];
  for (const file of files) {
    const text = await readFile(path.join(dir, file), "utf8");
    const parsed = fixtureSchema.parse(JSON.parse(text));
    fixtures.push(parsed);
  }
  return fixtures;
}

async function loadCharter(charterPath: string): Promise<PilotCharter> {
  const text = await readFile(charterPath, "utf8");
  return pilotCharterSchema.parse(JSON.parse(text));
}

interface RunCliInput {
  charterPath: string;
  fixturesDir: string;
  outDir: string;
  participants?: ReadonlyArray<string>;
  seed?: string;
  synthetic: boolean;
  canaries: ReadonlyArray<{ name: string; value: string }>;
}

export interface RunCliResult {
  exitCode: 0 | 1 | 2 | 3;
  pilotId: string;
  attempts: number;
  budgetRefusals: number;
  bundlePath: string;
  reportPath: string;
}

/** Internal seam used by tests to drive the CLI logic without spawning a subprocess. */
export async function runPilotCli(input: RunCliInput): Promise<RunCliResult> {
  let charter: PilotCharter;
  try {
    charter = await loadCharter(input.charterPath);
  } catch (err) {
    process.stderr.write(`charter error: ${(err as Error).message}\n`);
    return { exitCode: 3, pilotId: "", attempts: 0, budgetRefusals: 0, bundlePath: "", reportPath: "" };
  }
  if (input.participants) charter = { ...charter, participantIds: input.participants };
  if (input.seed) charter = { ...charter, seed: input.seed };

  const fixtures = await loadFixtures(input.fixturesDir);
  if (fixtures.length === 0) {
    process.stderr.write(`no fixtures discovered under ${input.fixturesDir}\n`);
    await mkdir(input.outDir, { recursive: true });
    const emptyReport = {
      pilotId: charter.pilotId,
      charterVersion: charter.charterVersion,
      graderVersion: charter.graderVersion,
      generatedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      cohort: { participantIds: charter.participantIds, conditionOrderByParticipant: {} },
      totals: { attempts: 0, accepted: 0, rejected: 0, abandoned: 0, timeout: 0, unknown: 0,
        totalCostUsd: 0, unknownCostAttempts: 0, budgetRefusals: 0 },
      byCondition: ["terminal-baseline", "native-provider", "minimal"].map((c) => ({
        condition: c as PilotCondition,
        attempts: 0, accepted: 0, totalCostUsd: 0, meanHumanMinutes: 0,
      })),
      byFamily: [],
      perAttempt: [],
      budgetEvents: [],
      caveats: ["no fixtures discovered; run aborted before any attempt"],
    };
    const reportPath = path.join(input.outDir, "pilot-report.json");
    await writeFile(reportPath, JSON.stringify(emptyReport, null, 2));
    return {
      exitCode: 2, pilotId: charter.pilotId, attempts: 0, budgetRefusals: 0,
      bundlePath: "", reportPath,
    };
  }

  const result = await runPilot({ charter, fixtures, synthetic: input.synthetic });

  const report = rollAttempts({
    pilotId: charter.pilotId,
    charterVersion: charter.charterVersion,
    graderVersion: charter.graderVersion,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    cohort: result.cohort,
    attempts: result.attempts,
    budgetEvents: result.budgetEvents,
  });
  const validated = pilotReportSchema.parse(report);

  const pilotDir = path.join(input.outDir, charter.pilotId);
  await mkdir(pilotDir, { recursive: true });
  const ndjsonPath = path.join(pilotDir, "attempts.ndjson");
  // Plant canaries AFTER the schema validation but BEFORE writing, so a
  // canary token planted in the message field shows up verbatim in the
  // emitted NDJSON (the diagnostics-export pipeline then verifies it
  // gets scrubbed).
  const stamped = input.canaries.length === 0
    ? validated.perAttempt
    : validated.perAttempt.map((a, idx) => {
        const token = input.canaries[idx % input.canaries.length]!;
        return {
          ...a,
          failure: a.failure
            ? { ...a.failure, message: `${a.failure.message} canary:${token.value}` }
            : {
                code: "CANARY_PLANT",
                message: `canary:${token.value}`,
              },
        };
      });
  const ndjson = stamped.map((a) => JSON.stringify(a)).join("\n") + "\n";
  await writeFile(ndjsonPath, ndjson);
  const reportPath = path.join(pilotDir, "pilot-report.json");
  await writeFile(reportPath, JSON.stringify(validated, null, 2));

  const refusalCount = result.budgetEvents.filter((b) => b.kind === "refuse").length;
  const exitCode: 0 | 1 = refusalCount > 0 ? 1 : 0;
  return {
    exitCode,
    pilotId: charter.pilotId,
    attempts: validated.perAttempt.length,
    budgetRefusals: refusalCount,
    bundlePath: ndjsonPath,
    reportPath,
  };
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const result = await runPilotCli(args);
    process.stdout.write(
      `pilot-${args.synthetic ? "synthetic" : "real"} pilotId=${result.pilotId} attempts=${result.attempts} budgetRefusals=${result.budgetRefusals}\n`,
    );
    process.stdout.write(`bundle: ${result.bundlePath}\n`);
    process.stdout.write(`report: ${result.reportPath}\n`);
    process.exit(result.exitCode);
  } catch (error) {
    process.stderr.write(`run-pilot: ${(error as Error).message ?? String(error)}\n`);
    process.exit(2);
  }
}