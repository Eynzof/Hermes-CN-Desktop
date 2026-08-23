import { defineConfig, devices } from "@playwright/test";
import { VITE_PORT, DESKTOP_DIR } from "./harness/config.mjs";

// Local-first E2E config: no Python backend, no fake model, no MemOS.
// Only starts the Vite dev server in standalone web mode (run.py style).
// The local dashboard handlers + in-process gateway transport serve every
// route from the browser — exactly the production path for "no backend" users.
//
// Run:
//   DEEPSEEK_API_KEY=sk-... pnpm --filter @hermes/e2e exec playwright test --config=playwright.local.config.ts
export default defineConfig({
  testDir: "./specs",
  testMatch: /local-chat-e2e\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${VITE_PORT}`,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm --filter @hermes/web dev",
    cwd: DESKTOP_DIR,
    url: `http://localhost:${VITE_PORT}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
