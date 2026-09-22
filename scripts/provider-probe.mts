import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function inspectHelp(provider: "codex" | "claude", version: string, help: string) {
  const parsed = version.trim().match(provider === "codex" ? /^codex-cli (\d+\.\d+\.\d+)$/ : /^(\d+\.\d+\.\d+) \(Claude Code\)$/);
  const flag = (name: string) => new RegExp(`(?:^|\\s)${name}(?=\\s|,|=|$)`, "m").test(help);
  return {
    provider, version: parsed?.[1] ?? null, evidence: "installed-cli-help" as const,
    advertised: {
      structuredOutput: provider === "codex" ? flag("--json") : flag("--output-format") && /stream-json/.test(help),
      bidirectionalInput: provider === "claude" && flag("--input-format") && /stream-json/.test(help),
      continuation: provider === "codex" ? /^\s+resume\s/m.test(help) : flag("--resume"),
      backgroundLifecycle: provider === "claude" && flag("--background"),
      skipUserConfig: provider === "codex" && flag("--ignore-user-config"),
    },
    // Help is discovery evidence, never permission to advertise a working adapter.
    liveInvocationVerified: false, crashRecoveryVerified: false, productionQualified: false,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exec = promisify(execFile);
  const cwd = await mkdtemp(path.join(tmpdir(), "minimal-provider-probe-"));
  try {
    for (const provider of ["codex", "claude"] as const) {
      try {
        const options = { cwd, timeout: 10000, maxBuffer: 128 * 1024, encoding: "utf8" as const };
        const version = (await exec(provider, ["--version"], options)).stdout;
        const help = (await exec(provider, provider === "codex" ? ["exec", "--help"] : ["--help"], options)).stdout;
        process.stdout.write(JSON.stringify(inspectHelp(provider, version, help)) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ provider, available: false, reason: (error as NodeJS.ErrnoException).code ?? "probe-failed", productionQualified: false }) + "\n");
      }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
}
