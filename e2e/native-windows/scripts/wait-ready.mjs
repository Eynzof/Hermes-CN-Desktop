import { chromium } from '@playwright/test';
import { setTimeout } from 'node:timers/promises';
const endpoint = process.env.HERMES_E2E_CDP || 'http://127.0.0.1:19229';
const deadline = Date.now() + 120_000;
let targets;
while (Date.now() < deadline) {
  try {
    const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(2000) });
    targets = await response.json();
    if (targets.some(target => target.url?.includes('hermesui.localhost'))) break;
  } catch {}
  await setTimeout(500);
}
if (!targets?.some(target => target.url?.includes('hermesui.localhost'))) throw new Error('Installed WebView2 did not become available within 120 seconds');
const browser = await chromium.connectOverCDP(endpoint);
try {
  const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('hermesui.localhost'));
  // A deliberately stopped/uninstalled backend is a valid desktop launch.
  // Do not restart it from the harness or time out before testing Offline Shell.
  await page.waitForFunction(() => window.hermesDesktop?.getRuntimeInfo && (
    window.__HERMES_RUNTIME__?.backendReady ||
    ['stopped', 'uninstalled'].includes(window.__HERMES_RUNTIME__?.managedRuntimeDesiredState)
  ), undefined, { timeout: 120_000 });
  const runtime = await page.evaluate(() => window.hermesDesktop.getRuntimeInfo());
  console.log(JSON.stringify({ url: page.url(), mode: runtime.mode, root: runtime.runtimeRoot, current: runtime.current }));
} finally { await browser.close(); }
