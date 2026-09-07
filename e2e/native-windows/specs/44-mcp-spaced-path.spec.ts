import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, route, api, chat, root, python } from '../fixtures';

test('MCP-005 带空格的 Windows 路径参数、真实服务探测和模型调用', async ({ app }, testInfo) => {
  const name = `e2e-spaced-${Date.now()}`;
  const directory = path.join(root, 'workspace', 'MCP path with spaces');
  mkdirSync(directory, { recursive: true });
  const script = path.join(directory, 'real digest server.py');
  copyFileSync(path.join(root, 'native-windows', 'scripts', 'mcp-evidence.py'), script);
  await route(app, '/mcp');
  await app.getByRole('button', { name: '添加服务', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await dialog.getByPlaceholder('例如 filesystem').fill(name);
  await dialog.getByRole('combobox', { name: '传输方式', exact: true }).selectOption('stdio');
  await dialog.getByPlaceholder('npx').fill(python);
  await dialog.getByPlaceholder('-y @modelcontextprotocol/server-filesystem /tmp').fill(`"${script}" ${root}`);
  await dialog.getByRole('button', { name: '添加', exact: true }).click();
  const card = app.locator('[class*="card"]').filter({ has: app.getByText(name, { exact: true }) }).filter({ has: app.getByRole('button', { name: '测试连接', exact: true }) });
  try {
    await expect(dialog).toBeHidden({ timeout: 60_000 });
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled({ timeout: 60_000 });
    await testInfo.attach('actual-spaced-path-probe', { body: await card.ariaSnapshot(), contentType: 'text/plain' });
    const server = (await api(app, '/api/mcp/servers')).servers.find((server: any) => server.name === name);
    await testInfo.attach('stored-spaced-arguments', { body: JSON.stringify(server, null, 2), contentType: 'application/json' });
    await expect(card).toContainText('e2e_digest');
    const marker = 'spaced-path-' + Date.now();
    const expected = createHash('sha256').update(marker).digest('hex');
    const result = await chat(app, `必须使用 MCP 服务 ${name} 的 e2e_digest 工具计算 ${marker} 的 SHA256，仅回复工具返回值。`, expected);
    expect(readFileSync(path.join(root, 'workspace', 'mcp-events.jsonl'), 'utf8')).toContain(expected);
    expect(result.evidence.messages.some((m: any) => m.role === 'tool' && m.tool_name?.endsWith('_e2e_digest') && m.content?.includes(expected))).toBe(true);
    await testInfo.attach('real-spaced-path-tool-call', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
  } finally {
    await route(app, '/mcp');
    await card.getByRole('button', { name: '删除', exact: true }).click();
    await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(card).toHaveCount(0);
  }
});
