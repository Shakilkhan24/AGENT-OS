import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["**/desktop.spec.ts", "**/terminal-behavior.spec.ts", "**/terminal-edge-cases.spec.ts", "**/terminal-management.spec.ts", "**/foundation-extended.spec.ts", "**/shutdown-flush.spec.ts"],
  workers: 1,
  timeout: 90000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
