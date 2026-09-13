import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
// Removed/renamed source files must not leak into the next staged package.
await rm("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/main/index.ts"],
  outfile: "dist/main/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  sourcemap: true,
});
await build({
  entryPoints: ["src/preload/index.ts"],
  outfile: "dist/preload/index.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
await mkdir("dist/helpers", { recursive: true });
await cp("helpers", "dist/helpers", {
  recursive: true,
  filter: (source) => !source.includes("__pycache__"),
});
