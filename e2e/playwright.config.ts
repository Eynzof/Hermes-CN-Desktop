import { defineConfig, devices } from "@playwright/test";
import {
  DASHBOARD_ORIGIN,
  HERMES_HOME,
  VITE_PORT,
  DESKTOP_DIR,
} from "./harness/config.mjs";

// Three webServers, all started and health-checked before tests run:
//   1. the deterministic backend (fake model + real Core dashboard)
//   2. the real desktop Vite frontend, with /api + /api/ws proxied to (1) via
//      HERMES_DASHBOARD_ORIGIN — the single seam that redirects the backend.
//   3. the real MemOS backend (WanderMemory, port-shift/CORS branch) + its
//      dummy OpenAI LLM, serving /v1 (+/v1/fs via the Vite proxy) for the
//      /wander-memory surface.
// Tests then drive the actual UI exactly as a user would.
export default defineConfig({
  testDir: "./specs",
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
    {
      // Real MemOS (WanderMemory) backend + dummy LLM for /wander-memory.
      // The harness spawns `python -m src.memory --remote <cfg> --db-path …
      // --cors-origins http://localhost:9545` from WANDER_MEMORY_DIR (env,
      // default ../Wander-Memory) and prints MEMOS_READY once healthy.
      command: "node harness/start-memos.mjs",
      url: "http://127.0.0.1:18400/v1/health",
      timeout: 120_000,
      reuseExistingServer: !process.env.CI,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
