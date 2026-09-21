import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: "http://127.0.0.1:33117",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun run build:ui && bun tests/browser/server-fixture.ts",
    url: "http://127.0.0.1:33117/health",
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
