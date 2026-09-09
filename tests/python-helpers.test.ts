import test from "node:test";
import { execFileSync } from "node:child_process";
test("Python file helpers verify bounded previews, save races and interrupted WSL fallbacks", () => {
  execFileSync("python3", ["-m", "unittest", "discover", "-s", "tests/python"], { timeout: 15000, env: { ...process.env, PYTHONPATH: "helpers", PYTHONDONTWRITEBYTECODE: "1" } });
});
