import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// Local verification config for this Windows machine (slow cold start:
// Vite first paint ~120s, backend + MemOS boot). The stock 60s test /
// 15s expect timeouts make most specs flaky here even though the flows are
// healthy. This config keeps the exact same harness (real Core backend +
// fake model + MemOS + Vite on 9545) but gives every spec room to finish:
//
//   pnpm --filter @hermes/e2e exec playwright test --config=playwright.verify.config.ts
//
// You can also target a single spec:
//
//   pnpm --filter @hermes/e2e exec playwright test --config=playwright.verify.config.ts chat-loop
//   pnpm --filter @hermes/e2e exec playwright test --config=playwright.verify.config.ts settings-workflow
export default defineConfig({
  ...base,
  // Slow first paint / backend warmup on this host needs a much longer budget.
  timeout: 240_000,
  expect: { timeout: 90_000 },
  // One retry absorbs the cold-start flake on a fresh webServer.
  retries: 1,
  reporter: [["list"]],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
