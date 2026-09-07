import { test, expect, route, api, chat, deepseekKey, baseline } from '../fixtures';

test('MODEL-003 自定义官方端点添加修改、错误凭证、真实调用及删除', async ({ app }, testInfo) => {
  const name = `E2E DeepSeek ${Date.now()}`;
  await route(app, '/models');
  await app.getByRole('tab', { name: /^主模型/ }).click();
  await app.getByRole('button', { name: '本地部署', exact: true }).click();
  const local = app.getByRole('dialog');
  await local.getByRole('button', { name: /^Ollama/ }).click();
  await expect(local.getByRole('textbox', { name: 'Base URL', exact: true })).toHaveValue('http://127.0.0.1:11434/v1');
  await local.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('4096');
  await expect(local.getByRole('alert')).toContainText('64');
  await local.getByRole('button', { name: '取消', exact: true }).click();
  await app.getByRole('button', { name: '自定义配置', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill('invalid-url');
  await expect(dialog.getByText('Base URL 必须是 http 或 https 地址。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '添加并选中', exact: true })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseline.baseUrl);
  await dialog.getByRole('radio', { name: 'Anthropic (Claude Code)', exact: true }).click();
  await expect(dialog.getByRole('radio', { name: 'Anthropic (Claude Code)', exact: true })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByRole('radio', { name: 'OpenAI 兼容', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'API Key', exact: true }).fill('e2e-intentionally-invalid-key');
  await dialog.getByRole('combobox', { name: '默认模型', exact: true }).fill(baseline.model);
  await dialog.getByRole('combobox', { name: '默认模型', exact: true }).press('Enter');
  await dialog.getByRole('button', { name: '添加并选中', exact: true }).click();
  await expect(dialog).toBeHidden();
  try {
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(app.getByText(/401|Authentication Fails|Invalid API|认证失败/)).toBeVisible({ timeout: 60_000 });
    await app.getByRole('textbox', { name: 'API Key', exact: true }).fill(deepseekKey());
    await app.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('1048576');
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    await expect(app.getByText(/✓ 连接成功 · 延迟/)).toBeVisible({ timeout: 60_000 });
    // Adding the custom entry already promotes it to the default model.
    expect((await api(app, '/api/model/info')).provider).toMatch(/^custom:api-deepseek-com/);
    await expect(app.getByRole('button', { name: '已是当前模型', exact: true })).toBeVisible();
    await app.getByRole('button', { name: '删除服务商', exact: true }).click();
    await expect(app.getByText(/当前主模型正在使用此服务商，请先切换到其他模型后再删除/)).toBeVisible();
    const { evidence } = await chat(app, '请只回复 CUSTOM-PROVIDER-READY。', 'CUSTOM-PROVIDER-READY');
    expect(evidence.session.model).toBe(baseline.model);
    expect(evidence.session.billing_base_url).toBe(baseline.baseUrl);
    await testInfo.attach('custom-provider-call', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } catch (error) {
    await testInfo.attach('primary-error', { body: String(error).replaceAll(deepseekKey(), '[REDACTED_SECRET]'), contentType: 'text/plain' });
    throw error;
  } finally {
    await route(app, '/models');
  await app.getByRole('tab', { name: /^主模型/ }).click();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    const current = app.getByRole('button', { name: '设为当前模型', exact: true });
    if ((await api(app, '/api/model/info')).provider !== 'deepseek') await current.click();
    await expect.poll(async () => (await api(app, '/api/model/info')).provider).toBe('deepseek');
    await app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) }).click();
    await app.getByRole('button', { name: '删除服务商', exact: true }).click();
    const confirm = app.getByRole('dialog', { name: '删除服务商', exact: true });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    await expect(app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) })).toBeVisible();
    await app.getByRole('button', { name: '删除服务商', exact: true }).click();
    await confirm.getByRole('button', { name: '删除', exact: true }).click();
    await expect(app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) })).toHaveCount(0);
  }
});
