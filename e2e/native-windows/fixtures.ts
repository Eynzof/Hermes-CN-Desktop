import { test as base, expect, chromium, type Page } from '@playwright/test';
import { readFileSync, mkdirSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./baseline.json', import.meta.url)), 'utf8'));
export const root = process.env.HERMES_E2E_ROOT || 'C:\\HermesE2E';
export const home = path.join(root, 'runtime', 'hermes-home');
export const python = process.env.HERMES_E2E_PYTHON || path.join(root, '.venv', 'Scripts', 'python.exe');

export function deepseekKey() {
  const value = readFileSync(path.join(root, 'secrets', 'deepseek.env'), 'utf8')
    .split(/\r?\n/).find(line => line.startsWith('DEEPSEEK_API_KEY='))?.slice('DEEPSEEK_API_KEY='.length).trim();
  if (!value) throw new Error('Private DeepSeek key is missing');
  return value;
}

function redact(text: string) {
  return text.replaceAll(deepseekKey(), '[REDACTED_SECRET]');
}

export function sessionEvidence(session: string, sessionHome = home) {
  return JSON.parse(execFileSync(python, [fileURLToPath(new URL('./scripts/session-evidence.py', import.meta.url)), sessionHome, session], { encoding: 'utf8' }));
}

export async function native(input: Record<string, unknown>) {
  const id = randomUUID();
  const inbox = path.join(root, 'control', 'inbox');
  const output = path.join(root, 'control', 'outbox', `${id}.json`);
  mkdirSync(inbox, { recursive: true });
  const request = path.join(inbox, `${id}.json`);
  writeFileSync(request + '.tmp', JSON.stringify({ ...input, id }));
  renameSync(request + '.tmp', request);
  await expect.poll(() => existsSync(output), { timeout: 30_000, message: 'Interactive Windows UI helper response' }).toBe(true);
  const result = JSON.parse(readFileSync(output, 'utf8').replace(/^\uFEFF/, ''));
  if (!result.ok) throw new Error(`Native UI action failed: ${result.error}`);
  return result;
}

export async function nativeDialog(title: string, destination?: string, submit = '%s') {
  await expect.poll(async () => (await native({ action: 'windows' })).windows.some((w: any) => w.name === title),
    { timeout: 30_000, message: `Native dialog ${title}` }).toBe(true);
  if (destination === undefined) {
    await native({ action: 'keys', window: title, keys: '{ESC}' });
  } else if (title === '选择工作区') {
    const controls = (await native({ action: 'windowControls', window: title })).controls;
    // The folder picker uses a plain Win32 Edit (1152), not the common
    // File name (Alt+N) field. Resolve its live controls before interacting.
    expect(controls.some((c: any) => c.id === 1152 && c.type === 'Edit')).toBe(true);
    expect(controls.some((c: any) => c.id === 1 && c.text === '选择文件夹')).toBe(true);
    await native({ action: 'setControlText', window: title, controlId: 1152, value: destination });
    await native({ action: 'clickButton', window: title, controlId: 1 });
  } else {
    // Use the common dialog's visible File name (Alt+N) field. UIA's legacy
    // provider on this Windows build does not expose Value/Invoke patterns for
    // all common-dialog controls, so enter through the real keyboard instead.
    await native({ action: 'keys', window: title, keys: '%n^a' });
    await native({ action: 'paste', window: title, value: destination });
    await native({ action: 'keys', window: title, keys: submit });
  }
  await expect.poll(async () => (await native({ action: 'windows' })).windows.some((w: any) => w.name === title)).toBe(false);
}

export async function api<T = any>(page: Page, path: string): Promise<T> {
  return page.evaluate(async path => {
    const runtime = (window as any).__HERMES_RUNTIME__;
    const token = runtime.sessionToken || (window as any).__HERMES_SESSION_TOKEN__;
    const result = await (window as any).hermesDesktop.request({ path, method: 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Hermes-Session-Token': token } });
    if (!result.ok) throw new Error(`Native API ${path}: ${result.status} ${result.body}`);
    return JSON.parse(result.body);
  }, path);
}

export const test = base.extend<{ app: Page }>({
  app: async ({}, use, testInfo) => {
    if (process.platform !== 'win32') throw new Error('Native acceptance must execute on Windows');
    const browser = await chromium.connectOverCDP(process.env.HERMES_E2E_CDP || 'http://127.0.0.1:19229');
    const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('hermesui.localhost'));
    if (!page) { await browser.close(); throw new Error('Installed Hermes WebView2 page was not found'); }
    page.setDefaultTimeout(20_000);
    page.setDefaultNavigationTimeout(30_000);
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(`${message.type()}: ${message.text()}`); });
    try {
    await page.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady, undefined, { timeout: 120_000 });
    const runtime = await bridge<any>(page, 'getRuntimeInfo');
    expect(runtime.runtimeRoot.toLowerCase()).toBe(path.join(root, 'runtime').toLowerCase());
    expect(runtime.mode).toBe('managed');
    expect(runtime.current.sourceCommit).toBe(baseline.coreCommit);
    expect(runtime.process.currentProfile, 'Each workflow must start from the isolated default profile').toBe('default');
    await testInfo.attach('installation-provenance', { body: JSON.stringify({ appSha256: process.env.HERMES_E2E_APP_SHA256, current: runtime.current, root: runtime.runtimeRoot }, null, 2), contentType: 'application/json' });
      const windows = (await native({ action: 'windows' })).windows;
      expect(windows.filter((w: any) => w.class === '#32770'), 'A native dialog from an earlier case must not cover the next workflow').toHaveLength(0);
      const mainWindow = windows.find((w: any) => w.class === 'Tauri Window');
      expect(mainWindow).toBeTruthy();
      if (mainWindow.minimized) await native({ action: 'windowState', window: mainWindow.name, state: 'normal' });
      await native({ action: 'activate', window: mainWindow.name });
      if (!testInfo.title.startsWith('MODEL-001')) await expect(page.getByRole('dialog', { name: '开始使用 Hermes', exact: true }), 'Unexpected first-use gate left by a previous workflow').toBeHidden({ timeout: 1000 });
      // Start each independent case with an unmounted previous route. Evidence
      // for the previous failure has already been collected in its teardown.
      await route(page, '/health');
      await route(page, '/');
      await use(page);
    } finally {
      try {
      const dialogs = (await native({ action: 'windows' })).windows.filter((w: any) => w.class === '#32770');
      if (dialogs.length || testInfo.status !== testInfo.expectedStatus) {
        const shot = await native({ action: 'screenshot' });
        await testInfo.attach('native-desktop', { path: shot.path, contentType: 'image/png' });
      }
      // Dismiss the enabled modal child before its disabled file-picker owner.
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = (await native({ action: 'windows' })).windows.filter((w: any) => w.class === '#32770');
        if (!current.length) break;
        const active = current.find((w: any) => w.enabled);
        if (!active) throw new Error('No enabled app dialog can receive Escape');
        await native({ action: 'keys', window: active.name, windowHandle: active.handle, keys: '{ESC}' });
      }
      if (!page.isClosed()) {
        await testInfo.attach('window', { body: await page.screenshot({ mask: [page.locator('input[type="password"]')] }), contentType: 'image/png' });
        await testInfo.attach('accessibility', { body: redact(await page.locator('body').ariaSnapshot()), contentType: 'text/plain' });
      }
      await testInfo.attach('page-errors', { body: redact(JSON.stringify(errors, null, 2)), contentType: 'application/json' });
      } finally { await browser.close(); }
    }
  },
});

export { expect };

export async function route(page: Page, path: string) {
  await page.evaluate(path => { location.hash = `#${path}`; }, path);
  await page.waitForFunction(path => location.hash === `#${path}`, path);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator('[data-route-loading]')).toHaveCount(0);
}

export async function chat(page: Page, prompt: string, answer: string | RegExp) {
  await route(page, '/');
  return sendChat(page, prompt, answer);
}

export async function sendChat(page: Page, prompt: string, answer: string | RegExp) {
  const sessionHome = (await bridge<any>(page, 'getRuntimeInfo')).process.hermesHome;
  const previousId = page.url().includes('#/tasks/') ? decodeURIComponent(page.url().split('#/tasks/')[1].split('?')[0]) : null;
  const completed = (id: string) => sessionEvidence(id, sessionHome).log.filter((line: string) =>
    line.includes('tui turn finished:') && line.includes('status=complete') && line.includes('error_retained=False')).length;
  const previousTurns = previousId ? completed(previousId) : 0;
  await page.getByRole('textbox', { name: '输入消息', exact: true }).fill(prompt);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page).toHaveURL(/#\/tasks\/.+/);
  const id = decodeURIComponent(page.url().split('#/tasks/')[1].split('?')[0]);
  // A tool-call argument can already contain the marker, and token counters
  // are updated after every model call. Neither means the turn has ended.
  await expect.poll(() => completed(id), { timeout: 120_000 }).toBeGreaterThan(id === previousId ? previousTurns : 0);
  await expect(page.getByRole('button', { name: '中止响应', exact: true })).toHaveCount(0);
  await expect(page.getByRole('log').locator('[data-role="assistant"]').last()).toContainText(answer);
  await expect.poll(() => sessionEvidence(id, sessionHome)?.session?.output_tokens, { timeout: 120_000 }).toBeGreaterThan(0);
  return { id, evidence: sessionEvidence(id, sessionHome) };
}

export async function switchProfile(page: Page, name: string) {
  await route(page, '/profiles');
  const browse = page.getByRole('button', { name: '先看看界面', exact: true });
  if (await browse.isVisible()) await browse.click();
  await page.getByRole('button', { name: `切换到 ${name} 档案`, exact: true }).click();
  await expect(page.getByText('正在切换档案…', { exact: true })).toBeVisible();
  await expect(page.getByText('正在切换档案…', { exact: true })).toBeHidden({ timeout: 90_000 });
  await expect.poll(async () => (await bridge<any>(page, 'getRuntimeInfo')).process.currentProfile).toBe(name);
}

export async function removeProfile(page: Page, name: string) {
  await route(page, '/profiles');
  await page.getByRole('button', { name: `${name} 的操作`, exact: true }).click();
  await page.getByRole('menuitem', { name: '删除', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByRole('button', { name: `${name} 的操作`, exact: true })).toHaveCount(0);
}

export async function bridge<T = unknown>(page: Page, method: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, input }) => {
    const desktop = (window as any).hermesDesktop;
    if (typeof desktop?.[method] !== 'function') throw new Error(`Missing native bridge: ${method}`);
    return desktop[method](input);
  }, { method, input });
}
