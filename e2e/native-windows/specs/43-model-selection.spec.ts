import { test, expect, route, api, chat, sendChat, baseline } from '../fixtures';

test('MODEL-008 官方模型刷新搜索、默认模型及会话模型切换后真实 Flash 调用', async ({ app }, testInfo) => {
  const models = async () => {
    await route(app, '/models');
    await app.getByRole('tab', { name: /^主模型/ }).click();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
  };
  const saveModel = async (model: string) => {
    const picker = app.getByRole('combobox', { name: '模型', exact: true });
    await picker.click();
    await picker.fill(model);
    await picker.press('Enter');
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/model/info')).model).toBe(model);
  };
  await models();
  const refresh = app.getByTitle('从 https://api.deepseek.com/v1/models 拉取', { exact: true });
  await refresh.click();
  await expect(refresh).toHaveText(/已加载 [1-9]\d* 个/, { timeout: 40_000 });
  const picker = app.getByRole('combobox', { name: '模型', exact: true });
  await picker.click();
  await picker.fill('deepseek-v4-flash');
  await expect(app.getByRole('option', { name: baseline.model, exact: true })).toBeVisible();
  await picker.press('Enter');
  await testInfo.attach('real-provider-model-list', { body: await app.getByRole('main').ariaSnapshot(), contentType: 'text/plain' });
  try {
    // Change selection only. No prompt or probe is sent to another model.
    await saveModel('deepseek-v4-pro');
    await app.reload();
    await expect(app.getByRole('combobox', { name: '模型', exact: true })).toHaveValue('deepseek-v4-pro');
    await saveModel(baseline.model);
    const first = await chat(app, '不要使用工具，仅回复 MODEL-SELECTION-READY。', 'MODEL-SELECTION-READY');
    for (const model of ['deepseek-v4-pro', baseline.model]) {
      await app.getByRole('button', { name: /^模型 deepseek-v4-/ }).click();
      const dialog = app.getByRole('dialog', { name: '切换模型', exact: true });
      const search = dialog.getByRole('textbox', { name: '搜索模型、平台或能力', exact: true });
      await search.fill('no-matching-model-e2e');
      await expect(dialog.getByRole('button', { name: /^切换到 / })).toHaveCount(0);
      await search.fill(model);
      await dialog.getByRole('button', { name: `切换到 DeepSeek 的 ${model}`, exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(app.getByRole('button', { name: `模型 ${model}`, exact: true })).toBeVisible();
    }
    const result = await sendChat(app, '仍然不要使用工具，仅回复 FLASH-SELECTION-VERIFIED。', 'FLASH-SELECTION-VERIFIED');
    expect(result.evidence.session.id).toBe(first.evidence.session.id);
    expect(result.evidence.session.model).toBe(baseline.model);
    expect(result.evidence.session.billing_provider).toBe('deepseek');
    expect(result.evidence.session.tool_call_count).toBe(0);
    expect(result.evidence.log.filter((line: string) => /LLM.*request|model call/.test(line)).some((line: string) => line.includes('deepseek-v4-pro'))).toBe(false);
    await testInfo.attach('real-flash-after-selection', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
  } finally {
    await models();
    if ((await api(app, '/api/model/info')).model !== baseline.model) await saveModel(baseline.model);
  }
});
