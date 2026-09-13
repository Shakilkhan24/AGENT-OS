import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { TmuxEngine } from "../src/main/engine";

const base = await mkdtemp(path.join(tmpdir(), "minimal-package-"));
const root = path.join(base, "project");
await mkdir(root);
const data = path.join(base, "data");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--executable")) throw new Error("Usage: package-smoke.ts [--executable PATH]");
const executable = path.resolve(args[1] ?? `release/current-linux-${process.arch}/minimal`);
// Exercise the package with only its documented external programs on PATH.
// The test harness uses Node; the actual application cannot resolve global Node/npm.
const bin = path.join(base, "bin");
await mkdir(bin); await mkdir(data);
for (const name of ["python3", "tmux", "bash", "sleep"]) {
  const resolved = execFileSync("/bin/sh", ["-c", 'command -v "$1"', "resolve", name], { encoding: "utf8" }).trim();
  await symlink(resolved, path.join(bin, name));
}
await writeFile(path.join(data, "settings.json"), JSON.stringify({ shellMode: "clean" }));
// This is a normal executable launch. Unlike Playwright's Electron launcher,
// no --no-sandbox flag is added, so this checks the distributed runtime too.
const child = spawn(executable, ["--remote-debugging-port=0"], {
  env: { ...process.env, PATH: bin, MINIMAL_DATA_DIR: data },
  stdio: ["ignore", "pipe", "pipe"],
});
const exit = once(child, "exit");
const engine = new TmuxEngine(data, path.resolve("helpers/pty_bridge.py"));
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let logs = "";
try {
  const address = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Packaged app did not launch: ${logs}`)),
      20000,
    );
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      logs += chunk.toString();
      const found = logs.match(/DevTools listening on (ws:\/\/\S+)/);
      if (found) {
        clearTimeout(timer);
        resolve(found[1]);
      }
    });
  });
  browser = await chromium.connectOverCDP(address);
  const context = browser.contexts()[0];
  const page = context.pages()[0] || (await context.waitForEvent("page"));
  await page
    .getByRole("heading", { name: "Your work, still running." })
    .waitFor();
  assert.equal(
    await page.evaluate(() => typeof (globalThis as any).require),
    "undefined",
  );
  const manifest = JSON.parse(await readFile(path.join(path.dirname(executable), "resources/app/package.json"), "utf8"));
  assert.match(manifest.version, /^\d+\.\d+\.\d+/);
  await page.evaluate(async (root) => {
    const state = await window.minimal.createSession(
      "Runtime verification",
      root,
    );
    const preset = {
      id: crypto.randomUUID(),
      name: "Worker",
      command: "while :; do printf 'worker output\\n'; sleep 0.05; done",
    };
    await window.minimal.savePresets([preset]);
    await window.minimal.createTerminals(
      state.sessions[0].id,
      preset.id,
      12,
      "",
    );
  }, root);
  await page.getByRole("tab").nth(11).waitFor();
  const start = performance.now();
  for (let i = 0; i < 12; i++) await page.getByRole("tab").nth(i).click();
  await page
    .locator(".terminal-caption")
    .filter({ hasText: "Connected" })
    .waitFor();
  const latency = Math.round(performance.now() - start);
  assert.ok(latency < 5000, `Switching under load took ${latency} ms`);
  const before = await page.evaluate(() => window.minimal.snapshot());
  assert.equal(
    before.sessions[0].terminals.filter((t) => t.status === "running").length,
    12,
  );
  await page.close();
  const exited = await Promise.race([
    exit,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Packaged app did not close")),
        10000,
      );
      timer.unref();
    }),
  ]);
  assert.equal(exited[0], 0);
  const processes = await engine.inspect();
  assert.deepEqual(
    [...processes.values()].map((p) => p.pid).sort(),
    before.sessions[0].terminals.map((t) => t.pid).sort(),
  );
  console.log(
    `Packaged app ${manifest.version} passed: sandboxed renderer, no global Node/npm on PATH, 12 active output-producing terminals, 12 tab switches in ${latency} ms, clean GUI exit, all processes survive.`,
  );
} finally {
  await browser?.close().catch(() => {});
  if (child.exitCode === null && child.signalCode === null) child.kill();
  for (const id of (await engine.inspect()).keys()) await engine.remove(id);
  await rm(base, { recursive: true, force: true });
}
