import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, root, api, python } from '../fixtures';

test('MCP-001 添加真实 stdio 服务、测试、启停、模型调用及删除', async ({ app }, testInfo) => {
  const name = `e2e-digest-${Date.now()}`;
  const marker = `mcp-${Date.now()}`;
  const expected = createHash('sha256').update(marker).digest('hex');
  await route(app, '/mcp');
  await app.getByRole('button', { name: '添加服务', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await dialog.getByPlaceholder('例如 filesystem').fill(name);
  await dialog.getByRole('combobox', { name: '传输方式', exact: true }).selectOption('stdio');
  await dialog.getByPlaceholder('npx').fill(python);
  // The shipped editor splits on whitespace and retains literal quote marks.
  // This isolated root has no spaces; paths with spaces need separate coverage.
  await dialog.getByPlaceholder('-y @modelcontextprotocol/server-filesystem /tmp').fill(`${path.join(root, 'native-windows', 'scripts', 'mcp-evidence.py')} ${root}`);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  await expect(dialog).toHaveCount(0, { timeout: 60_000 });
  const card = app.locator('[class*="card"]').filter({ has: app.getByText(name, { exact: true }) }).filter({ has: app.getByRole('button', { name: '测试连接', exact: true }) });
  await card.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(card).toContainText('e2e_digest', { timeout: 60_000 });
  await card.getByRole('button', { name: '禁用', exact: true }).click();
  await expect(card.getByText('已禁用', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: '启用', exact: true }).click();
  await expect(card.getByRole('button', { name: '禁用', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: '重新载入', exact: true }).click();
  const { evidence } = await chat(app, `请必须调用 MCP 服务 ${name} 的 e2e_digest 工具，参数 text 为 ${marker}。不要使用其他工具计算哈希，最后只回复这个工具返回的完整 SHA256。`, expected);
  const events = readFileSync(path.join(root, 'workspace', 'mcp-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.some(e => e.text === marker && e.sha256 === expected)).toBe(true);
  expect(evidence.messages.some((m: any) => m.role === 'tool' && m.content?.includes(expected))).toBe(true);
  await testInfo.attach('mcp-model-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await route(app, '/mcp');
  await card.getByRole('button', { name: '删除', exact: true }).click();
  await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(card).toHaveCount(0);
  const servers = await api(app, '/api/mcp/servers');
  expect(servers.servers.some((server: any) => server.name === name)).toBe(false);
});
