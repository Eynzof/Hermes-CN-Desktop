import { defineConfig, devices } from "@playwright/test";
import {
  DASHBOARD_ORIGIN,
  HERMES_HOME,
  VITE_PORT,
  DESKTOP_DIR,
} from "./harness/config.mjs";

const wanderMemoryE2E = process.env.WANDER_MEMORY_E2E !== "false";

// Two core webServers are always started and health-checked before tests run:
//   1. the deterministic backend (fake model + real Core dashboard)
//   2. the real desktop Vite frontend, with /api + /api/ws proxied to (1) via
//      HERMES_DASHBOARD_ORIGIN — the single seam that redirects the backend.
// For trusted CI/local runs, a third server starts the canonical WanderMemory
// backend with a dummy OpenAI LLM for the /wander-memory surface. Untrusted PRs
// set WANDER_MEMORY_E2E=false, which omits that server and its private-repo spec.
// Tests then drive the actual UI exactly as a user would.
export default defineConfig({
  testDir: "./specs",
  testIgnore: wanderMemoryE2E ? [] : [/wander-memory\.spec\.ts$/],
  // 首个 spec 前预热整条链路（Vite 冷转换 + 后端冷端点），见该文件头注释。
  globalSetup: "./harness/global-warmup.mjs",
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
    permissions: ["clipboard-read", "clipboard-write"],
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
    ...(wanderMemoryE2E
      ? [
          {
            // Real canonical WanderMemory backend + dummy LLM. The checkout
            // defaults to the desktop repository's ../Wander-Memory sibling.
            command: "node harness/start-memos.mjs",
            url: "http://127.0.0.1:18400/v1/health",
            timeout: 120_000,
            reuseExistingServer: !process.env.CI,
            stdout: "pipe" as const,
            stderr: "pipe" as const,
          },
        ]
      : []),
  ],
});
