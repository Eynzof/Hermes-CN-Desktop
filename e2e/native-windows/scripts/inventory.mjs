import { chromium } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.env.HERMES_E2E_ROOT || 'C:\\HermesE2E';
const output = path.join(root, 'reports', 'inventory');
await mkdir(output, { recursive: true });
const routes = JSON.parse(await readFile(new URL('../route-catalog.json', import.meta.url), 'utf8'));
const browser = await chromium.connectOverCDP(process.env.HERMES_E2E_CDP || 'http://127.0.0.1:19229');
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('hermesui.localhost'));
if (!page) throw new Error('Installed Windows WebView2 not found');
const initialUrl = page.url();
const results = [];
try {
  for (const [id, route, feature] of routes) {
    const errors = [];
    const onError = error => errors.push(error.message);
    page.on('pageerror', onError);
    try {
      await page.evaluate(route => { location.hash = '#' + route; }, route);
      await page.waitForFunction(route => location.hash === '#' + route, route);
      // Let the hashchange, React commit, and lazy Suspense boundary run.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.locator('[data-route-loading]').waitFor({ state: 'detached' });
      await page.getByText(/^(正在加载.*|加载中…|读取中)$/).first().waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});
      const snapshot = await page.locator('body').ariaSnapshot();
      await writeFile(path.join(output, `${id}.yaml`), snapshot, 'utf8');
      await page.screenshot({ path: path.join(output, `${id}.png`), fullPage: true });
      const controls = await page.locator('main button, main input, main textarea, main select, main a, [role="main"] button').evaluateAll(elements => elements.map(el => ({
        tag: el.tagName, role: el.getAttribute('role'), label: el.getAttribute('aria-label'),
        text: el.textContent?.trim(), placeholder: el.getAttribute('placeholder'),
        type: el.getAttribute('type'), disabled: el.hasAttribute('disabled'), href: el.getAttribute('href'),
      })));
      results.push({ id, route, feature, observation: 'captured', errors, controls });
      console.log(`CAPTURE ${id} (${controls.length} controls)`);
    } catch (error) {
      results.push({ id, route, feature, observation: 'capture-failed', error: error.message, errors });
      console.error(`CAPTURE FAILED ${id}: ${error.message}`);
    } finally {
      page.off('pageerror', onError);
      await writeFile(path.join(output, 'index.json'), JSON.stringify(results, null, 2));
    }
  }
} finally {
  await page.evaluate(url => { location.hash = new URL(url).hash; }, initialUrl);
  await browser.close();
}
// Captures are reconnaissance evidence, never a functional pass.
if (results.some(row => row.observation === 'capture-failed')) process.exitCode = 1;
