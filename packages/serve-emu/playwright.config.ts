import { defineConfig } from "@playwright/test";
import {
  FIXTURE_PORT,
  FIXTURE_TOKEN,
  TOKEN_FIXTURE_PORT,
} from "./tests/browser/fixture-env.ts";

export default defineConfig({
  testDir: "./tests/browser",
  testMatch: "**/*.pw.ts",
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: `http://127.0.0.1:${FIXTURE_PORT}`,
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "bun run build:ui && bun tests/browser/server-fixture.ts",
      url: `http://127.0.0.1:${FIXTURE_PORT}/health`,
      env: { SERVE_EMU_FIXTURE_PORT: String(FIXTURE_PORT) },
      timeout: 30_000,
      reuseExistingServer: false,
    },
    {
      // The same fixture with authentication on (401 counts as ready).
      command: "bun tests/browser/server-fixture.ts",
      url: `http://127.0.0.1:${TOKEN_FIXTURE_PORT}/health`,
      env: {
        SERVE_EMU_FIXTURE_PORT: String(TOKEN_FIXTURE_PORT),
        SERVE_EMU_FIXTURE_TOKEN: FIXTURE_TOKEN,
      },
      timeout: 30_000,
      reuseExistingServer: false,
    },
  ],
});
