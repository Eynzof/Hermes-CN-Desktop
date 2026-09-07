import { test, expect, route, api, bridge, chat, switchProfile, removeProfile } from '../fixtures';

test('MEMCFG-001 记忆总览、启用外置服务、通过高级配置停用及真实内置记忆对话', async ({ app }, testInfo) => {
  const name = `memory-toggle-${Date.now()}`;
  await route(app, '/profiles');
  await app.getByRole('button', { name: '新建档案', exact: true }).click();
  await app.getByRole('dialog').getByPlaceholder('例如 work / sandbox').fill(name);
  await app.getByRole('dialog').getByRole('combobox').first().selectOption('default');
  await app.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await expect(app.getByRole('button', { name: `${name} 的操作` })).toBeVisible();
  try {
    await switchProfile(app, name);
    await route(app, '/memconfig');
    await expect(app.getByText('未启用外置后端', { exact: true })).toBeVisible();
    await app.getByRole('main').getByRole('link', { name: /^Hindsight/ }).click();
    await app.getByRole('combobox', { name: /^Mode Connection/ }).selectOption('local_external');
    await app.getByRole('textbox', { name: /^API URL / }).fill('http://127.0.0.1:18888');
    await app.getByRole('textbox', { name: /^Dashboard URL / }).fill('http://127.0.0.1:19999/dashboard');
    await app.getByRole('textbox', { name: /^Bank ID / }).fill(name);
    await app.getByRole('button', { name: '保存并检测', exact: true }).click();
    await expect(app.getByRole('button', { name: '设为当前', exact: true })).toBeEnabled({ timeout: 60_000 });
    await app.getByRole('button', { name: '设为当前', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/memory')).active).toBe('hindsight');
    await route(app, '/memconfig');
    await app.getByRole('button', { name: '刷新全部', exact: true }).click();
    await expect(app.getByRole('main').getByRole('link', { name: /^Hindsight/ })).toContainText('当前');
    // The dedicated panel currently has no disable button. Exercise the
    // product's existing advanced configuration control, and keep the saved
    // provider settings so reconnecting remains possible.
    await route(app, '/config');
    await app.getByPlaceholder('搜索配置项…').fill('memory.provider');
    const selector = app.getByRole('main').getByRole('combobox');
    await expect(selector).toHaveCount(1);
    await selector.selectOption('');
    await expect.poll(async () => (await api(app, '/api/memory')).active || '').toBe('');
    await app.reload();
    await route(app, '/memconfig');
    await expect(app.getByText('未启用外置后端', { exact: true })).toBeVisible();
    const saved = await api(app, '/api/memory/providers/hindsight/config');
    expect(saved.fields.find((f: any) => f.key === 'bank_id').value).toBe(name);
    const result = await chat(app, '仅回复 BUILTIN-MEMORY-MODE，不要使用工具。', 'BUILTIN-MEMORY-MODE');
    expect(result.evidence.session.billing_provider).toBe('deepseek');
    expect(result.evidence.session.tool_call_count).toBe(0);
    await testInfo.attach('disabled-provider-real-session', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
  } finally {
    if ((await bridge<any>(app, 'getRuntimeInfo')).process.currentProfile !== 'default') await switchProfile(app, 'default');
    await removeProfile(app, name);
    await app.reload();
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
  }
});
