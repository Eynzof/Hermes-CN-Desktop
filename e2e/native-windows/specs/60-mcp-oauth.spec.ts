import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, api, root, python } from '../fixtures';

test('MCP-004 真实 OAuth 受保护服务的授权入口与登录前置门槛', async ({ app }, testInfo) => {
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const eventsFile = testInfo.outputPath('oauth-service-events.ndjson');
  const events = () => existsSync(eventsFile) ? readFileSync(eventsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const service = spawn(python, [path.join(root, 'native-windows', 'scripts', 'mcp-oauth-service.py'), String(port), eventsFile],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  service.stdout.on('data', data => diagnostics += data);
  service.stderr.on('data', data => diagnostics += data);
  const name = `oauth-digest-${Date.now()}`;
  const card = app.locator('[class*="card"]').filter({ has: app.getByText(name, { exact: true }) })
    .filter({ has: app.getByRole('button', { name: '测试连接', exact: true }) });
  let created = false;
  let desktopStart = 0;
  try {
    await expect.poll(async () => {
      if (service.exitCode !== null) throw new Error(`OAuth fixture exited: ${diagnostics}`);
      try { return (await fetch(`${base}/mcp`, { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; }
    }).toBe(401);
    const selfCheck = execFileSync(python, [path.join(root, 'native-windows', 'scripts', 'check-mcp-oauth.py'), base],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    await testInfo.attach('fixture-self-check-not-desktop-acceptance', { body: selfCheck, contentType: 'application/json' });
    desktopStart = events().length;
    await route(app, '/mcp');
    await app.getByRole('button', { name: '添加服务', exact: true }).click();
    const dialog = app.getByRole('dialog');
    await dialog.getByPlaceholder('例如 filesystem').fill(name);
    await dialog.getByRole('combobox').selectOption('http');
    await dialog.getByPlaceholder('https://example.com/mcp').fill(`${base}/mcp`);
    await testInfo.attach('oauth-add-dialog', { body: await dialog.ariaSnapshot(), contentType: 'text/plain' });
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    created = true;
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect.poll(() => events().slice(desktopStart).some(e => e.path === '/mcp' && e.status === 401)).toBe(true);
    await expect(card.locator('p')).toBeVisible({ timeout: 60_000 });
    await testInfo.attach('protected-mcp-card', { body: await card.ariaSnapshot(), contentType: 'text/plain' });
    await testInfo.attach('protected-mcp-page', { body: await app.screenshot(), contentType: 'image/png' });
    await testInfo.attach('saved-mcp-configuration', { body: JSON.stringify((await api(app, '/api/mcp/servers')).servers.find((s: any) => s.name === name), null, 2), contentType: 'application/json' });
    // An authorization endpoint called directly by this test would bypass the
    // missing user flow. Preserve the product failure at its earliest gate.
    await expect(card.getByRole('button', { name: /授权|登录|authenticate|sign in/i }),
      'OAuth 受保护服务返回 401 后应有可操作的授权入口；没有入口，登录、取消、刷新和退出无法从 Desktop 开始').toBeVisible();
    throw new Error('授权入口现已出现：需要接管实际新增界面并补齐后续 OAuth 流程，不能把入口存在判为整项通过');
  } finally {
    await testInfo.attach('oauth-desktop-events', { body: JSON.stringify(events().slice(desktopStart), null, 2), contentType: 'application/json' });
    await testInfo.attach('oauth-service-log', { body: diagnostics, contentType: 'text/plain' });
    if (created) {
      await route(app, '/mcp');
      await card.getByRole('button', { name: '删除', exact: true }).click();
      await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
      await expect.poll(async () => (await api(app, '/api/mcp/servers')).servers.some((s: any) => s.name === name)).toBe(false);
    }
    if (service.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(service.pid), '/T', '/F'], { windowsHide: true });
    await expect.poll(async () => {
      try { await fetch(`${base}/mcp`, { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
    }, { message: 'Owned OAuth service stopped with its child interpreter' }).toBe(false);
  }
});
