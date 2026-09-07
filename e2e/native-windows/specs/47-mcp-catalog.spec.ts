import { test, expect, route, api, chat } from '../fixtures';

test('MCP-003 官方目录安装 Microsoft Learn、真实文档工具调用及删除', async ({ app }, testInfo) => {
  await route(app, '/mcp');
  const catalog = await api(app, '/api/mcp/catalog');
  await testInfo.attach('shipped-mcp-catalog', { body: JSON.stringify(catalog, null, 2), contentType: 'application/json' });
  expect(catalog.entries.some((entry: any) => entry.name === 'microsoft-learn'), 'The shipped Core catalog includes the public Microsoft Learn service').toBe(true);
  const entry = app.locator('[class*="card"]').filter({ has: app.getByText('microsoft-learn', { exact: true }) }).filter({ has: app.getByRole('button', { name: '安装', exact: true }) });
  await entry.getByRole('button', { name: '安装', exact: true }).click();
  const card = app.locator('[class*="card"]').filter({ has: app.getByText('microsoft-learn', { exact: true }) }).filter({ has: app.getByRole('button', { name: '测试连接', exact: true }) });
  try {
    await card.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(card).toContainText('microsoft_docs_search', { timeout: 60_000 });
    const result = await chat(app, '必须调用 microsoft-learn MCP 的 microsoft_docs_search，查询 Windows PowerShell Get-Process 的官方说明。仅回复检索到的 learn.microsoft.com 文档链接，不要使用 web_search。', /https:\/\/learn\.microsoft\.com\//);
    expect(result.evidence.messages.some((m: any) => m.role === 'tool' && m.tool_name.includes('microsoft_docs_search') && m.content.includes('learn.microsoft.com'))).toBe(true);
    await testInfo.attach('official-catalog-real-tool-session', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
  } finally {
    await route(app, '/mcp');
    await card.getByRole('button', { name: '删除', exact: true }).click();
    await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(card).toHaveCount(0);
  }
});
