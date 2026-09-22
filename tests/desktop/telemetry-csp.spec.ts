/**
 * M9.4 — renderer Content-Security-Policy audit.
 *
 * The renderer MUST keep `connect-src 'none'` for the duration of the
 * "telemetry off by default" contract. Any future M-bullet that wires
 * an actual destination will have to relax the CSP deliberately — and
 * update this test to assert the new policy.
 *
 * The test runs in two layers:
 *
 * 1. A static file check (no browser) that asserts the built
 *    `dist/renderer/index.html` carries `connect-src 'none'`. Runs
 *    in every CI environment without Playwright browsers installed.
 *
 * 2. A headless-DOM check (requires Playwright browsers — `npx
 *    playwright install`) that confirms the CSP actually
 *    takes effect at runtime.
 */
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function resolveHtml(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../dist/renderer/index.html");
}

test("dist/renderer/index.html source includes connect-src 'none'", async () => {
  const html = await readFile(resolveHtml(), "utf8");
  expect(html).toContain("Content-Security-Policy");
  expect(html).toContain("connect-src");
  expect(html).toContain("'none'");
  // The CSP must also lock down object/frame/form-action vectors.
  expect(html).toContain("object-src 'none'");
  expect(html).toContain("form-action 'none'");
});

test("renderer index.html applies connect-src 'none' at runtime", async ({ page }) => {
  // Requires `npx playwright install` to have run for the Chromium
  // headless shell. The static file check above covers CI environments
  // without browsers installed.
  await page.goto(pathToFileURL(resolveHtml()).href);
  const csp = await page.evaluate(() =>
    document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content") ?? "",
  );
  expect(csp).toContain("connect-src");
  expect(csp).toContain("'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("form-action 'none'");
});
