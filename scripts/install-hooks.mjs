// Point git at the repo-local hooks in .githooks/ so pre-push runs `npm run check`
// automatically. Re-runnable; --uninstall restores the default git hook path.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

const RELATIVE_HOOKS_PATH = ".githooks";

function git(args) {
  return execFileSync("git", args, { stdio: "pipe" }).toString().trim();
}

if (process.argv.includes("--uninstall")) {
  execFileSync("git", ["config", "--unset", "core.hooksPath"], {
    stdio: "inherit",
  });
  console.log("Removed core.hooksPath (back to default).");
  process.exit(0);
}

if (!existsSync(".git")) {
  console.error("Not inside a git work tree. Run from the repo root.");
  process.exit(1);
}

const before = (() => {
  try {
    return git(["config", "--get", "core.hooksPath"]);
  } catch {
    return "";
  }
})();

execFileSync("git", ["config", "core.hooksPath", RELATIVE_HOOKS_PATH], {
  stdio: "inherit",
});

const after = git(["config", "--get", "core.hooksPath"]);

console.log(`core.hooksPath: ${before || "(default)"} -> ${after}`);
console.log("pre-push will now run `npm run check` before pushing.");
console.log(
  "Bypass once with MINIMAL_SKIP_PRE_PUSH=1 git push, or run `node scripts/install-hooks.mjs --uninstall`.",
);
