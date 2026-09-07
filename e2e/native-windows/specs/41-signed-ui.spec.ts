import { existsSync, readFileSync, writeFileSync, unlinkSync, watchFile, unwatchFile } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { test, expect, route, bridge, sendChat, root, sessionEvidence, quitFromTray } from '../fixtures';

test('RUNTIME-003 签名 UI 热更新、运行中真实任务不中断及界面回滚', async ({ app }, testInfo) => {
  test.setTimeout(300_000);
  const fixture = path.join(root, 'update-fixture');
  const currentFile = path.join(root, 'runtime', 'ui', 'current.json');
  expect(existsSync(currentFile), 'Start this workflow from the embedded UI baseline').toBe(false);
  const transitions: any[] = [];
  const ipc: any[] = [];
  watchFile(currentFile, { interval: 40 }, () => {
    if (existsSync(currentFile)) {
      try { transitions.push({ at: new Date().toISOString(), current: JSON.parse(readFileSync(currentFile, 'utf8')) }); } catch {}
    }
  });
  app.on('request', request => {
    if (/ui_(install_update|rollback)/.test(request.url())) ipc.push({ at: new Date().toISOString(), event: 'request', url: request.url() });
  });
  app.on('requestfailed', request => {
    if (/ui_(install_update|rollback)/.test(request.url())) ipc.push({ at: new Date().toISOString(), event: 'failed', url: request.url(), error: request.failure()?.errorText });
  });
  const before = await bridge<any>(app, 'getRuntimeInfo');
  const marker = `ui-inflight-${Date.now()}`;
  const started = path.join(root, 'workspace', marker + '-started.txt');
  const finished = path.join(root, 'workspace', marker + '-finished.txt');
  const mode = (version: number) => {
    const file = path.join(fixture, 'mode.json');
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ui: `ui-${version}.json` }));
  };
  const install = async (version: number) => {
    mode(version);
    await route(app, '/kernel');
    await app.getByRole('button', { name: '检查界面更新', exact: true }).click();
    await expect(app.getByText(`发现新界面版本 0.9.0-e2e.${version}，可热更新`, { exact: true })).toBeVisible({ timeout: 40_000 });
    await app.getByRole('button', { name: 'UI 热更新', exact: true }).click();
    const loaded = app.waitForEvent('load', { timeout: 90_000 });
    await app.getByRole('dialog', { name: 'UI 热更新', exact: true }).getByRole('button', { name: '立即热更新', exact: true }).click();
    await loaded;
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    await expect(app.locator('meta[name="hermes-native-e2e-ui"]')).toHaveAttribute('content', String(version));
    expect((await bridge<any>(app, 'getRuntimeInfo')).process.pid).toBe(before.process.pid);
    expect(JSON.parse(readFileSync(currentFile, 'utf8')).uiVersion).toBe(`0.9.0-e2e.${version}`);
    await testInfo.attach(`active-ui-${version}`, { body: await app.screenshot(), contentType: 'image/png' });
  };
  let task = '';
  try {
    const command = `powershell -NoProfile -Command "Set-Content -LiteralPath '${started.replaceAll('\\', '/')}' -Value 'START'; Start-Sleep -Seconds 35; Set-Content -LiteralPath '${finished.replaceAll('\\', '/')}' -Value 'DONE'"`;
    await route(app, '/');
    await app.getByRole('textbox', { name: '输入消息', exact: true }).fill(`用 terminal 同步执行这条命令，timeout=60，不要后台执行。成功后只回复 UI-TASK-DONE。命令：${command}`);
    await app.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(app).toHaveURL(/#\/tasks\//);
    task = decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]);
    await expect.poll(() => existsSync(started), { timeout: 60_000 }).toBe(true);
    expect(existsSync(finished)).toBe(false);
    await install(1);
    await expect.poll(() => existsSync(finished), { timeout: 90_000 }).toBe(true);
    expect(readFileSync(finished, 'utf8').trim()).toBe('DONE');
    await expect.poll(() => sessionEvidence(task).messages.filter((m: any) => m.role === 'assistant').at(-1)?.content?.trim(), { timeout: 60_000 }).toBe('UI-TASK-DONE');
    const evidence = sessionEvidence(task);
    expect(evidence.session.billing_provider).toBe('deepseek');
    expect(evidence.session.model).toBe('deepseek-v4-flash');
    expect(evidence.session.output_tokens).toBeGreaterThan(0);
    expect(evidence.messages.some((m: any) => m.role === 'tool' && m.tool_name === 'terminal')).toBe(true);
    await testInfo.attach('uninterrupted-real-task', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await install(2);
    await app.getByRole('button', { name: '回退界面', exact: true }).click();
    await app.getByRole('dialog', { name: '回退界面版本', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    await expect(app.locator('meta[name="hermes-native-e2e-ui"]')).toHaveAttribute('content', '2');
    await app.getByRole('button', { name: '回退界面', exact: true }).click();
    const rolledBack = app.waitForEvent('load', { timeout: 90_000 });
    await app.getByRole('dialog', { name: '回退界面版本', exact: true }).getByRole('button', { name: '回退', exact: true }).click();
    await rolledBack;
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    await testInfo.attach('rollback-record-and-served-index', { body: JSON.stringify({ current: JSON.parse(readFileSync(currentFile, 'utf8')), meta: await app.locator('meta[name="hermes-native-e2e-ui"]').getAttribute('content') }, null, 2), contentType: 'application/json' });
    await expect.soft(app.locator('meta[name="hermes-native-e2e-ui"]')).toHaveAttribute('content', '1');
    expect((await bridge<any>(app, 'getRuntimeInfo')).process.pid).toBe(before.process.pid);
    expect.soft(JSON.parse(readFileSync(currentFile, 'utf8')).uiVersion).toBe('0.9.0-e2e.1');
    await route(app, `/tasks/${evidence.session.id}`);
    const continued = await sendChat(app, '仅回复 UI-ROLLBACK-READY，不要调用工具。', 'UI-ROLLBACK-READY');
    await testInfo.attach('continued-after-ui-rollback', { body: JSON.stringify(continued.evidence, null, 2), contentType: 'application/json' });
  } finally {
    unwatchFile(currentFile);
    await testInfo.attach('ui-activation-and-ipc-timeline', { body: JSON.stringify({ transitions, ipc }, null, 2), contentType: 'application/json' });
    if (!app.isClosed()) {
      await testInfo.attach('ui-update-before-cleanup', { body: await app.screenshot(), contentType: 'image/png' });
      if (existsSync(currentFile)) await testInfo.attach('ui-current-before-cleanup', { path: currentFile, contentType: 'application/json' });
      if (task) {
        await route(app, `/tasks/${task}`);
        const stop = app.getByRole('button', { name: '中止响应', exact: true });
        if (await stop.isVisible()) await stop.click();
      }
    }
    // Restore the test baseline only after collecting the actual UI rollback
    // result. There is no product control for returning to the embedded UI.
    if (!app.isClosed() && existsSync(currentFile)) {
      const current = JSON.parse(readFileSync(currentFile, 'utf8'));
      expect(current.uiVersion).toMatch(/^0\.9\.0-e2e\.[12]$/);
      await quitFromTray();
      unlinkSync(currentFile);
      await promisify(execFile)('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'start.ps1'), '-UpdateFixture'], { windowsHide: true, timeout: 120_000 });
      const browser = await chromium.connectOverCDP('http://127.0.0.1:19229');
      try {
        const fresh = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('hermesui.localhost'))!;
        await expect(fresh.locator('meta[name="hermes-native-e2e-ui"]')).toHaveCount(0);
        await testInfo.attach('restored-embedded-ui', { body: await fresh.screenshot(), contentType: 'image/png' });
      } finally { await browser.close(); }
    }
    mode(1);
  }
});
