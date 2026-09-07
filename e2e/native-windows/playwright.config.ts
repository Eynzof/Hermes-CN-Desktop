import { defineConfig } from '@playwright/test';
import path from 'node:path';

const reportRoot = process.env.HERMES_E2E_REPORT || '.';

export default defineConfig({
  testDir: './specs',
  testIgnore: ['**/59-wander-memory.spec.ts'], // Feature hidden by product scope.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  outputDir: path.join(reportRoot, 'test-results'),
  reporter: [
    ['./scripts/console-reporter.cjs'],
    ['html', { outputFolder: path.join(reportRoot, 'playwright-report'), open: 'never' }],
    ['json', { outputFile: path.join(reportRoot, 'results.json') }],
    ['junit', { outputFile: path.join(reportRoot, 'junit.xml') }],
  ],
  // Tests attach to the installed Windows WebView2; no Vite or fake model server.
  use: { screenshot: 'only-on-failure', trace: 'off', actionTimeout: 20_000, navigationTimeout: 30_000 },
});
