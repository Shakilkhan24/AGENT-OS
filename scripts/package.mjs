import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
if (process.platform !== "linux")
  throw new Error("Build the Linux application from Linux or WSL.");
const destination = path.resolve(`release/minimal-linux-${process.arch}`);
await mkdir(destination, { recursive: true });
// Requiring Electron also downloads its runtime if this is a fresh install.
const electronDistribution = path.dirname(require("electron"));
await cp(electronDistribution, destination, { recursive: true });
await rename(
  path.join(destination, "electron"),
  path.join(destination, "minimal"),
);
const app = path.join(destination, "resources/app");
await mkdir(app, { recursive: true });
await cp("dist", path.join(app, "dist"), { recursive: true });
const manifest = JSON.parse(await readFile("package.json", "utf8"));
await writeFile(
  path.join(app, "package.json"),
  JSON.stringify(
    { name: "minimal", version: manifest.version, main: "dist/main/index.cjs" },
    null,
    2,
  ),
);
await cp("README.md", path.join(destination, "README.md"));
await cp("docs", path.join(destination, "docs"), { recursive: true });
await cp("ins.md", path.join(destination, "ins.md"));
console.log(
  `Built ${destination}/minimal\nRequires tmux, Bash, Python 3 and a Linux graphical desktop (or WSLg).`,
);
