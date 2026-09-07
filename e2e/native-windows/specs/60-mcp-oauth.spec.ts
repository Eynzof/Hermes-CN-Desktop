import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, native, api, home, root, python } from '../fixtures';

test('MCP-004 真实 OAuth 授权、取消、凭证刷新、模型调用与退出', async ({ app }, testInfo) => {
  test.setTimeout(420_000);
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
  const tokenFile = path.join(home, 'mcp-tokens', `${name}.json`);
  const tokenState = () => {
    if (!existsSync(tokenFile)) return null;
    const token = JSON.parse(readFileSync(tokenFile, 'utf8'));
    return { expiresAt: token.expires_at, hasRefresh: Boolean(token.refresh_token),
      fingerprint: createHash('sha256').update(token.access_token).digest('hex') };
  };
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19230');
  const consentPage = await browser.contexts()[0].newPage();
  const openConsent = async () => {
    await card.getByRole('button', { name: /^(OAuth 授权|重新授权)$/ }).click();
    let target: any;
    await expect.poll(async () => {
      target = (await native({ action: 'systemWindows' })).windows.find((w: any) =>
        w.type === 'Chrome_WidgetWin_1' && /Hermes E2E MCP 授权/.test(w.text));
      return Boolean(target);
    }, { timeout: 45_000 }).toBe(true);
    const window = { window: target.text, windowClass: target.type, windowHandle: target.handle };
    await native({ action: 'externalKeys', ...window, keys: '^l^c{ESC}' });
    const url = (await native({ action: 'clipboard' })).text;
    expect(new URL(url).origin).toBe(base);
    expect(new URL(url).pathname).toBe('/consent');
    // Inspect the exact URL opened by the product, then drive its actual
    // consent page in the isolated installed Chrome automation profile.
    await native({ action: 'externalKeys', ...window, keys: '^w' });
    await consentPage.goto(url);
    await expect(consentPage.getByRole('heading', { name: '授权本地 MCP 测试服务' })).toBeVisible();
  };
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
    await dialog.getByRole('combobox', { name: '传输方式', exact: true }).selectOption('http');
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
    await openConsent();
    await card.getByRole('button', { name: '取消授权', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('授权已取消');
    expect(tokenState()).toBeNull();
    // A late user approval in the already opened browser must not revive it.
    await consentPage.getByRole('button', { name: '同意授权', exact: true }).click();
    await expect(consentPage.locator('body')).toContainText(/expired|not found|no pending/i);
    expect(events().slice(desktopStart).filter(e => e.event === 'authorization_code_exchanged')).toHaveLength(0);
    expect(tokenState()).toBeNull();

    await openConsent();
    await consentPage.getByRole('button', { name: '取消授权', exact: true }).click();
    await expect(card.getByRole('status')).toContainText(/access_denied|failed|失败/i, { timeout: 45_000 });
    expect(tokenState()).toBeNull();

    await openConsent();
    await testInfo.attach('real-browser-consent', { body: await consentPage.screenshot(), contentType: 'image/png' });
    await consentPage.getByRole('button', { name: '同意授权', exact: true }).click();
    await expect(card.getByRole('status')).toHaveText('授权成功', { timeout: 60_000 });
    await expect(card).toContainText('e2e_oauth_digest', { timeout: 60_000 });
    await expect.poll(tokenState).not.toBeNull();
    const granted = tokenState()!;
    expect(granted.hasRefresh).toBe(true);
    const marker = `oauth-${Date.now()}`;
    const digest = createHash('sha256').update(marker).digest('hex');
    const result = await chat(app, `请调用 MCP 服务 ${name} 的 e2e_oauth_digest 工具，text 参数为 ${marker}。只回复工具返回的 SHA256，禁止自己计算。`, digest);
    expect(events().slice(desktopStart).some(e => e.event === 'tool_called' && e.text === marker && e.sha256 === digest)).toBe(true);
    expect(result.evidence.messages.some((m: any) => m.role === 'tool' && m.content?.includes(digest))).toBe(true);
    await testInfo.attach('authorized-deepseek-tool-call', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });

    await app.reload();
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    await route(app, '/mcp');
    expect((await api(app, '/api/mcp/servers')).servers.find((s: any) => s.name === name).auth).toBe('oauth');
    // Let the real issuer's short-lived token expire; never edit token files
    // or inject a refresh response into the product.
    await expect.poll(() => Date.now() / 1000 > granted.expiresAt + 1, { timeout: 140_000, intervals: [1000] }).toBe(true);
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect.poll(() => events().slice(desktopStart).some(e => e.event === 'refresh_token_rotated'), { timeout: 45_000 }).toBe(true);
    await expect(card).toContainText('e2e_oauth_digest', { timeout: 45_000 });
    await expect.poll(() => tokenState()?.fingerprint).not.toBe(granted.fingerprint);
    await testInfo.attach('persistent-token-lifecycle', { body: JSON.stringify({ granted, refreshed: tokenState() }), contentType: 'application/json' });

    await card.getByRole('button', { name: '退出登录', exact: true }).click();
    await app.getByRole('dialog', { name: '退出 MCP 登录', exact: true }).getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(card).toContainText('已退出登录并禁用服务', { timeout: 60_000 });
    expect(tokenState()).toBeNull();
    expect((await api(app, '/api/mcp/servers')).servers.find((s: any) => s.name === name).enabled).toBe(false);
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card).toContainText(/OAuth.*(token|auth)|登录|授权/, { timeout: 45_000 });

  } finally {
    await consentPage.close();
    await browser.close();
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
