import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { publishRelease, rollbackRelease } from "./release.mts";
const require = createRequire(import.meta.url);
if (process.platform !== "linux")
  throw new Error("Build the Linux application from Linux or WSL.");
const root = path.resolve("release");
await mkdir(root, { recursive: true });
async function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal || code})`)));
  });
}
// flock is held by a separate parent, so crashes release it without stale-lock deletion.
if (!process.argv.includes("--locked")) {
  await run("flock", ["--exclusive", "--nonblock", path.join(root, ".package.lock"),
    process.execPath, "--import", "tsx", fileURLToPath(import.meta.url), "--locked", ...process.argv.slice(2)]);
} else if (process.argv.includes("--rollback")) {
  process.stdout.write(`Previous build selected: ${await rollbackRelease(root, process.arch)}\nApplication data was not changed; schema compatibility still applies.\n`);
} else {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));
  const executable = await publishRelease({
    root, arch: process.arch, version: manifest.version,
    assemble: async directory => {
      await cp(path.dirname(require("electron")), directory, { recursive: true, verbatimSymlinks: true });
      await rename(path.join(directory, "electron"), path.join(directory, "minimal"));
      const app = path.join(directory, "resources/app");
      await mkdir(app, { recursive: true });
      await cp("dist", path.join(app, "dist"), { recursive: true });
      await writeFile(path.join(app, "package.json"), JSON.stringify({ name: "minimal", version: manifest.version, main: "dist/main/index.cjs" }, null, 2));
      for (const name of ["README.md", "docs", "ins.md"]) await cp(name, path.join(directory, name), { recursive: true });
    },
    smoke: executable => run(process.execPath, ["--import", "tsx", "tests/package-smoke.ts", "--executable", executable]),
  });
  process.stdout.write(`Verified and published: ${executable}\nPrevious packages and legacy release directories were preserved.\n`);
}
