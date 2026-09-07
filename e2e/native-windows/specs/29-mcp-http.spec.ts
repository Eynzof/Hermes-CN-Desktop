import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, api, root, python } from '../fixtures';

test('MCP-002 真实 HTTP MCP 探测、模型调用、服务离线错误与删除', async ({ app }, testInfo) => {
  const reserve = createServer();
  await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const service = spawn(python, [path.join(root, 'native-windows', 'scripts', 'mcp-evidence.py'), root, String(port)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnostics = '';
  service.stdout.on('data', data => diagnostics += data);
  service.stderr.on('data', data => diagnostics += data);
  const name = `http-digest-${Date.now()}`;
  let created = false;
  const card = app.locator('[class*="card"]').filter({ has: app.getByText(name, { exact: true }) }).filter({ has: app.getByRole('button', { name: '测试连接', exact: true }) });
  try {
    await expect.poll(async () => {
      if (service.exitCode !== null) throw new Error(`HTTP MCP exited: ${diagnostics}`);
      try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) })).status; } catch { return 0; }
    }).toBe(404);
    await route(app, '/mcp');
    await app.getByRole('button', { name: '添加服务', exact: true }).click();
    const dialog = app.getByRole('dialog');
    await dialog.getByPlaceholder('例如 filesystem').fill(name);
    await dialog.getByRole('combobox', { name: '传输方式', exact: true }).selectOption('http');
    await dialog.getByPlaceholder('https://example.com/mcp').fill(`http://127.0.0.1:${port}/mcp`);
    await dialog.getByRole('button', { name: '添加', exact: true }).click();
    await expect(dialog).toHaveCount(0, { timeout: 60_000 });
    created = true;
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card).toContainText('e2e_digest', { timeout: 60_000 });
    const marker = `http-${Date.now()}`;
    const hash = createHash('sha256').update(marker).digest('hex');
    const result = await chat(app, `请调用 MCP 服务 ${name} 的 e2e_digest 工具，参数 text=${marker}，仅回复返回的 SHA256。禁止自己计算。`, hash);
    const events = readFileSync(path.join(root, 'workspace', 'mcp-events.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(events.some(event => event.text === marker && event.sha256 === hash)).toBe(true);
    expect(result.evidence.messages.some((m: any) => m.role === 'tool' && m.content?.includes(hash))).toBe(true);
    service.kill();
    await new Promise<void>(resolve => service.once('exit', () => resolve()));
    await route(app, '/mcp');
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card).toContainText(/失败|error|connect/i, { timeout: 60_000 });
    await testInfo.attach('http-mcp-session', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
  } finally {
    if (service.exitCode === null) service.kill();
    await testInfo.attach('http-mcp-service-log', { body: diagnostics, contentType: 'text/plain' });
    if (created) {
      await route(app, '/mcp');
      await card.getByRole('button', { name: '删除', exact: true }).click();
      await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
      await expect.poll(async () => (await api(app, '/api/mcp/servers')).servers.some((s: any) => s.name === name)).toBe(false);
    }
  }
});
