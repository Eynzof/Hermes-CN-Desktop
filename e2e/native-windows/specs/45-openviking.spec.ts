import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, api, bridge, chat, root, switchProfile, removeProfile } from '../fixtures';

test('OV-001 真实 OpenViking 连接、独立档案写入、跨会话向量检索与删除', async ({ app }, testInfo) => {
  test.setTimeout(300_000);
  const name = `openviking-${Date.now()}`;
  const passphrase = `琥珀鹭-${Math.random().toString(36).slice(2)}`;
  const secret = JSON.parse(readFileSync(path.join(root, 'secrets', 'openviking-client.json'), 'utf8')).result.user_key;
  expect((await (await fetch('http://127.0.0.1:19333/health')).json()).status).toBe('ok');
  await route(app, '/profiles');
  await app.getByRole('button', { name: '新建档案', exact: true }).click();
  await app.getByRole('dialog').getByPlaceholder('例如 work / sandbox').fill(name);
  await app.getByRole('dialog').getByRole('combobox').first().selectOption('default');
  await app.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await expect(app.getByRole('button', { name: `${name} 的操作` })).toBeVisible();
  try {
    await switchProfile(app, name);
    await route(app, '/openviking');
    await app.getByRole('textbox', { name: /^Endpoint/ }).fill('http://127.0.0.1:19333');
    await app.getByLabel(/^API Key/).fill(secret);
    await app.getByText(/^高级配置 · \d+ 项$/).click();
    await app.getByRole('textbox', { name: /^Agent / }).fill(name);
    await app.getByRole('button', { name: '保存并检测', exact: true }).click();
    await expect(app.getByText('已保存并完成状态检测；确认在线后可设为当前。', { exact: true })).toBeVisible();
    await expect(app.getByRole('button', { name: '设为当前', exact: true })).toBeEnabled({ timeout: 60_000 });
    const configured = await api(app, '/api/memory/providers/openviking/status');
    expect(configured.healthy).toBe(true);
    await app.getByRole('button', { name: '设为当前', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/memory')).active).toBe('openviking');
    const stored = await chat(app, `必须调用 viking_remember 保存一条 entity 记忆：研究者 ${name} 的发射口令是 ${passphrase}。仅使用 OpenViking，不要写本地文件或内置 memory。保存成功后只回复 VIKING-STORED。`, 'VIKING-STORED');
    expect(stored.evidence.messages.find((m: any) => m.role === 'tool' && m.tool_name === 'viking_remember')?.content).toContain('"status":"stored"');
    // Indexing is asynchronous. Query the real service's search index without
    // fabricating results or inserting data through a fixture API.
    await expect.poll(async () => {
      const r = await fetch('http://127.0.0.1:19333/api/v1/search/find', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': secret }, body: JSON.stringify({ query: name, target_uri: `viking://user/default/peers/${name}/memories`, limit: 5 }) });
      const body = await r.json();
      return r.ok && body.result?.memories?.some((item: any) => item.uri.includes(`/peers/${name}/`));
    }, { timeout: 90_000 }).toBe(true);
    const recalled = await chat(app, `这是新会话。必须调用 viking_search 搜索研究者 ${name} 的发射口令，必要时用 viking_read 读取结果。不要搜索文件、历史会话或内置记忆。仅回复检索到的完整口令。`, passphrase);
    expect(recalled.evidence.session.id).not.toBe(stored.evidence.session.id);
    expect(recalled.evidence.session.model).toBe('deepseek-v4-flash');
    expect(recalled.evidence.session.billing_provider).toBe('deepseek');
    expect(recalled.evidence.messages.some((m: any) => m.role === 'tool' && /^viking_(search|read)$/.test(m.tool_name) && m.content.includes(passphrase))).toBe(true);
    const removed = await chat(app, `仅操作测试研究者 ${name} 的记忆。先用 viking_search 获取其记忆的精确 URI，再用 viking_forget 删除这一个测试记忆文件。不能删除其他记忆或整个目录。完成后仅回复 VIKING-DELETED。`, 'VIKING-DELETED');
    expect(removed.evidence.messages.some((m: any) => m.role === 'tool' && m.tool_name === 'viking_forget' && !/"error"\s*:/.test(m.content))).toBe(true);
    await testInfo.attach('openviking-real-sessions', { body: JSON.stringify({ configured, stored: stored.evidence, recalled: recalled.evidence, removed: removed.evidence }, null, 2).replaceAll(secret, '[REDACTED_SECRET]'), contentType: 'application/json' });
  } finally {
    if ((await bridge<any>(app, 'getRuntimeInfo')).process.currentProfile !== 'default') await switchProfile(app, 'default');
    await removeProfile(app, name);
    await app.reload();
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    expect((await api(app, '/api/memory')).active || '').toBe('');
  }
});
