import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Explicit discovery keeps nested TypeScript tests portable across Node versions. */
export async function discoverTests(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discoverTests(file));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) files.push(file);
  }
  return files.sort();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const files = await discoverTests("tests");
  if (!files.length) throw new Error("No backend tests discovered");
  if (process.argv.includes("--list")) {
    process.stdout.write(files.join("\n") + `\n${files.length} backend test files\n`);
  } else {
    const child = spawn(process.execPath, [
      "--import", "tsx", "--test", "--test-concurrency=1", ...process.argv.slice(2), ...files,
    ], { stdio: "inherit" });
    child.on("error", error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
    child.on("exit", (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      else process.exitCode = code ?? 1;
    });
  }
}
