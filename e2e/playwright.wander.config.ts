import { defineConfig, devices } from "@playwright/test";

// Minimal E2E config for the /wander-memory surface ONLY:
//   • webServer: the real Vite dev server (already running → reuse).
//   • No Core dashboard: the Wander Memory pages talk DIRECTLY to the real
//     MemOS backend (llama.cpp local model) on 18400/18401/18402 via the
//     Vite /v1 proxy + browser WebSocket, so no Core is required.
//   • The MemOS backend is expected to be ALREADY RUNNING externally:
//       python -m src.memory --model models/Qwen3.5-4B --device CUDA0 …
//     (real llama.cpp local model — see the parent task).
export default defineConfig({
  testDir: "./specs",
  // Only the /wander-memory surface — the other specs need the Core backend.
  testMatch: "wander-memory.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:9545`,
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    // CopyButton uses navigator.clipboard — grant it in headless Chromium.
    permissions: ["clipboard-read", "clipboard-write"],
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // The Vite dev server is started manually (it must run with the right
      // env) — reuse it when already up, otherwise start it.
      command: "pnpm --filter @hermes/web dev",
      cwd: "..",
      url: "http://localhost:9545/",
      timeout: 120_000,
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
