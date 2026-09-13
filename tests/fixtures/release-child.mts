import { writeFile } from "node:fs/promises";
import path from "node:path";
import { publishRelease } from "../../scripts/release.mts";

const [root, phase] = process.argv.slice(2);
await publishRelease({
  root, arch: "x64", version: "1.2.2",
  assemble: directory => writeFile(path.join(directory, "minimal"), "second"),
  smoke: async () => {},
  checkpoint: async observed => {
    if (observed === phase) process.kill(process.pid, "SIGKILL");
  },
});
