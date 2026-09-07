import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, sendChat, chat, bridge, root, deepseekKey, quitFromTray } from '../fixtures';

test('SET-005 内置及真实外部 Core 的本地自动令牌、远程令牌连接与恢复', async ({ app }, testInfo) => {
  test.setTimeout(300_000);
  const marker = `external-${Date.now()}`;
  const externalHome = path.join(root, 'secrets', 'external-cores', marker);
  mkdirSync(externalHome, { recursive: true });
  writeFileSync(path.join(externalHome, '.env'), `DEEPSEEK_API_KEY=${deepseekKey()}\n`);
  writeFileSync(path.join(externalHome, 'config.yaml'), 'model:\n  provider: deepseek\n  default: deepseek-v4-flash\n  base_url: https://api.deepseek.com/v1\n  context_length: 1048576\n  max_tokens: 2048\n  supports_vision: false\n');
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const current = (await bridge<any>(app, 'getRuntimeInfo')).current;
  const token = `external-e2e-${randomUUID()}`;
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = { ...process.env, HERMES_HOME: externalHome, HERMES_DASHBOARD_SESSION_TOKEN: token, HERMES_NO_ANALYTICS: '1', PYTHONUTF8: '1' };
  for (const name of ['HERMES_PROFILE', 'HERMES_DESKTOP', 'HERMES_DESKTOP_MANAGED', 'DEEPSEEK_API_KEY']) delete env[name];
  const service = spawn(current.executablePath, ['serve', '--host', '127.0.0.1', '--port', String(port), '--isolated'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  service.stdout.on('data', chunk => diagnostics += chunk);
  service.stderr.on('data', chunk => diagnostics += chunk);
  const configFile = path.join(root, 'runtime', 'connection.json');
  const original = existsSync(configFile) ? readFileSync(configFile) : null;
  let restored = false;
  const reconnect = async (label: string, mode: string) => {
    const loaded = app.waitForEvent('load', { timeout: 90_000 });
    await app.getByRole('button', { name: label, exact: true }).click();
    await loaded;
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady, undefined, { timeout: 90_000 });
    expect((await bridge<any>(app, 'getConnectionConfig')).effectiveMode).toBe(mode);
  };
  try {
    await expect.poll(async () => {
      if (service.exitCode !== null) throw new Error(`External real Core exited ${service.exitCode}`);
      try { return (await fetch(`${baseUrl}/api/health`, { headers: { 'X-Hermes-Session-Token': token }, signal: AbortSignal.timeout(1000) })).status; } catch { return 0; }
    }, { timeout: 90_000 }).toBe(200);
    await route(app, '/connection');
    await app.getByRole('radio', { name: /^外部 Hermes / }).click();
    await app.getByRole('radio', { name: /^本机其他 Hermes/ }).click();
    await app.getByPlaceholder('http://127.0.0.1:9119').fill(baseUrl);
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(app.getByText(/^连接正常（/)).toBeVisible({ timeout: 60_000 });
    await reconnect('保存并连接本地', 'local');
    await route(app, '/');
    let local;
    try {
      local = await sendChat(app, `不要调用工具，只回复 LOCAL-${marker}。`, `LOCAL-${marker}`, externalHome);
    } catch (error) {
      await testInfo.attach('external-first-send-failure', { body: await app.screenshot(), contentType: 'image/png' });
      expect.soft(error, 'First send after a successful local connection must work').toBeUndefined();
      // Explicit recovery action, never an automatic passing retry. The first
      // failure remains a failed assertion while remote mode is also tested.
      local = await sendChat(app, `不要调用工具，只回复 LOCAL-${marker}。`, `LOCAL-${marker}`, externalHome);
    }
    expect(local.evidence.session.billing_provider).toBe('deepseek');
    expect(local.evidence.session.model).toBe('deepseek-v4-flash');
    await route(app, '/connection');
    await app.getByRole('radio', { name: /^远端服务器 Hermes/ }).click();
    await app.getByPlaceholder('https://gateway.example.com/hermes').fill(baseUrl);
    const password = app.locator('input[type="password"]').first();
    await password.fill('external-e2e-intentionally-invalid');
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(app.locator('[class*="connResult"]').filter({ hasText: /401|403|认证|令牌|token/i })).toBeVisible({ timeout: 60_000 });
    await password.fill(token);
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(app.getByText(/^连接正常（/)).toBeVisible({ timeout: 60_000 });
    await reconnect('保存并连接远程', 'remote');
    await route(app, `/tasks/${local.evidence.session.id}`);
    const remote = await sendChat(app, `不要调用工具，只回复 REMOTE-${marker}。`, `REMOTE-${marker}`, externalHome);
    expect(remote.evidence.session.id).toBe(local.evidence.session.id);
    await route(app, '/connection');
    await app.getByRole('radio', { name: /^内置内核/ }).click();
    await reconnect('保存并切回本机内核', 'managed');
    restored = true;
    const managed = await chat(app, `不要调用工具，只回复 MANAGED-${marker}。`, `MANAGED-${marker}`);
    expect(managed.evidence.session.id).not.toBe(local.evidence.session.id);
    await testInfo.attach('real-external-core-connections', { body: JSON.stringify({ coreCommit: current.sourceCommit, executable: current.executablePath, externalPid: service.pid, baseUrl, local: local.evidence, remote: remote.evidence, managed: managed.evidence }, null, 2), contentType: 'application/json' });
  } catch (error) {
    if (!app.isClosed()) await testInfo.attach('external-connection-failure-before-cleanup', { body: await app.screenshot(), contentType: 'image/png' });
    throw error;
  } finally {
    if (!restored) {
      // Restore fixture persistence only after retaining the failed UI path.
      // This cleanup does not count as a successful connection operation.
      await testInfo.attach('external-failure-cleanup', { body: JSON.stringify({ restoredByFixture: true }), contentType: 'application/json' });
      if (!app.isClosed()) await quitFromTray();
      if (original) writeFileSync(configFile, original); else rmSync(configFile, { force: true });
      execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'start.ps1')], { encoding: 'utf8', windowsHide: true, timeout: 120_000 });
    }
    if (service.exitCode === null) service.kill();
    await testInfo.attach('external-real-core-log', { body: diagnostics.replaceAll(deepseekKey(), '[REDACTED_SECRET]').replaceAll(token, '[REDACTED_TOKEN]'), contentType: 'text/plain' });
  }
});
