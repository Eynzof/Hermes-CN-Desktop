import { defineConfig, devices } from "@playwright/test";
import {
  DASHBOARD_ORIGIN,
  HERMES_HOME,
  VITE_PORT,
  DESKTOP_DIR,
} from "./harness/config.mjs";

// Two webServers, both started and health-checked before tests run:
//   1. the deterministic backend (fake model + real Core dashboard)
//   2. the real desktop Vite frontend, with /api + /api/ws proxied to (1) via
//      HERMES_DASHBOARD_ORIGIN — the single seam that redirects the backend.
// Tests then drive the actual UI exactly as a user would.
export default defineConfig({
  testDir: "./specs",
  // One backend + shared session store -> keep tests serial and deterministic.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node harness/start-backend.mjs",
      // Dashboard serves the stub index at `/` once it's ready.
      url: `${DASHBOARD_ORIGIN}/`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: "pnpm --filter @hermes/web dev",
      cwd: DESKTOP_DIR,
      url: `http://localhost:${VITE_PORT}`,
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      env: {
        HERMES_DASHBOARD_ORIGIN: DASHBOARD_ORIGIN,
        HERMES_HOME,
      },
    },
  ],
});
