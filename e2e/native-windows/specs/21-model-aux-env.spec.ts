import { test, expect, route, api, chat, sendChat, baseline, sessionEvidence } from '../fixtures';

async function selectReasoning(app: any, label: string) {
  await app.getByRole('button', { name: /^思考 / }).click();
  await app.getByRole('menuitemradio', { name: label, exact: true }).click();
}

test('MODEL-002 模型平台搜索刷新、会话模型选择和全部思考档位', async ({ app }, testInfo) => {
  const original = (await api(app, '/api/config')).agent?.reasoning_effort || 'medium';
  const labels: Record<string, string> = { none: '关闭思考', minimal: '最小', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最大' };
  await route(app, '/models');
  await app.getByRole('tab', { name: /^主模型/ }).click();
  await app.getByPlaceholder('搜索模型平台...').fill('unmatched-platform-unique');
  await expect(app.getByText('没有匹配的模型平台', { exact: true })).toBeVisible();
  await app.getByPlaceholder('搜索模型平台...').fill('DeepSeek');
  await expect(app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ })).toBeVisible();
  await app.getByPlaceholder('搜索模型平台...').fill('');
  await app.getByRole('button', { name: '刷新预设', exact: true }).click();
  await expect(app.getByRole('button', { name: '刷新预设', exact: true })).toBeEnabled();
  const { id } = await chat(app, '请只回复 MODEL-PICKER-READY。', 'MODEL-PICKER-READY');
  try {
    await app.getByRole('button', { name: /^模型 / }).click();
    const search = app.getByRole('textbox', { name: '搜索模型、平台或能力', exact: true });
    await search.fill(baseline.model);
    await app.getByRole('button', { name: `切换到 DeepSeek 的 ${baseline.model}`, exact: true }).click();
    await expect(app.getByRole('textbox', { name: '搜索模型、平台或能力', exact: true })).toBeHidden();
    for (const [value, label] of Object.entries(labels)) {
      await selectReasoning(app, label);
      await expect(app.getByRole('button', { name: /^思考 / })).toHaveText(`思考${value === 'none' ? '关闭' : label}`);
      await expect.poll(() => sessionEvidence(id).session.reasoning_config).toEqual(value === 'none' ? { enabled: false } : { enabled: true, effort: value });
      // v0.21 stores a session override; changing a conversation must not
      // rewrite the global default (the older Desktop comment is stale).
      expect((await api(app, '/api/config')).agent?.reasoning_effort || 'medium').toBe(original);
    }
    await selectReasoning(app, '关闭思考');
    const { evidence } = await sendChat(app, '请只回复 THINKING-OFF-READY。', 'THINKING-OFF-READY');
    expect(evidence.session.model).toBe(baseline.model);
    await testInfo.attach('model-selection-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally {
    const closePicker = app.getByRole('button', { name: '关闭模型选择', exact: true });
    if (await closePicker.isVisible()) await closePicker.click();
    await route(app, `/tasks/${id}`);
    await selectReasoning(app, labels[original]);
  }
});

test('MODEL-004 辅助模型、智能审批、图片输入模式及配置恢复', async ({ app }, testInfo) => {
  const before = await api(app, '/api/config');
  const task = before.auxiliary?.approval || {};
  const imageMode = before.agent?.image_input_mode || 'auto';
  const go = async () => { await route(app, '/models'); await app.getByRole('tab', { name: /^辅助模型/ }).click(); };
  await go();
  const image = app.getByRole('combobox').first();
  for (const mode of ['text', 'native', 'auto']) {
    await image.selectOption(mode);
    await expect.poll(async () => (await api(app, '/api/config')).agent?.image_input_mode).toBe(mode);
  }
  await app.getByRole('button', { name: /^智能审批 审批/ }).click();
  const provider = app.getByRole('combobox', { name: '服务商', exact: true });
  try {
    await provider.selectOption('deepseek');
    await app.getByRole('combobox', { name: '模型', exact: true }).fill(baseline.model);
    await app.getByRole('combobox', { name: '模型', exact: true }).press('Enter');
    await app.getByRole('textbox', { name: '调用超时（秒）', exact: true }).fill('45');
    await app.getByRole('button', { name: '高级设置', exact: false }).click();
    const json = app.getByRole('textbox', { name: 'extra_body JSON', exact: true });
    await json.fill('{broken');
    await app.getByRole('button', { name: '保存此辅助任务', exact: true }).click();
    await expect(app.getByText(/操作失败：.*JSON/)).toBeVisible();
    await json.fill('{}');
    await app.getByRole('button', { name: '保存此辅助任务', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/config')).auxiliary?.approval?.model).toBe(baseline.model);
    await app.reload();
    await go();
    await app.getByRole('button', { name: /^智能审批 审批/ }).click();
    await expect(app.getByRole('textbox', { name: '调用超时（秒）', exact: true })).toHaveValue('45');
    await app.getByRole('button', { name: '选择审批模式', exact: true }).click();
    await expect(app.getByRole('radio', { name: /^Smart 智能审批/ })).toBeVisible();
    await testInfo.attach('auxiliary-config', { body: JSON.stringify((await api(app, '/api/config')).auxiliary.approval, null, 2), contentType: 'application/json' });
  } finally {
    await go();
    await app.getByRole('combobox').first().selectOption(imageMode);
    await app.getByRole('button', { name: /^智能审批 审批/ }).click();
    if (!task.provider || task.provider === 'auto') await app.getByRole('button', { name: '恢复为自动', exact: true }).click();
    else {
      await provider.selectOption(task.provider);
      await app.getByRole('combobox', { name: '模型', exact: true }).fill(task.model || '');
      await app.getByRole('textbox', { name: '调用超时（秒）', exact: true }).fill(String(task.timeout || 30));
      await app.getByRole('button', { name: '保存此辅助任务', exact: true }).click();
    }
  }
});

test('MODEL-007 高级环境变量设置、取消替换、查看隐藏与删除', async ({ app }) => {
  const key = 'XAI_API_KEY';
  const vars = await api(app, '/api/env');
  expect(vars[key].is_set, 'Only use an unconfigured fixture key').toBe(false);
  const value = `e2e-not-a-real-provider-key-${Date.now()}`;
  await route(app, '/models');
  await app.getByRole('tab', { name: /^主模型/ }).click();
  await app.getByRole('button', { name: /高级环境变量/ }).click();
  const row = app.getByText(new RegExp(`${key} ·`)).locator('..').locator('..');
  try {
    await row.getByRole('button', { name: '设置', exact: true }).click();
    await row.getByPlaceholder('输入值…').fill(value);
    await row.getByRole('button', { name: '保存', exact: true }).click();
    await expect(row.getByRole('button', { name: '替换', exact: true })).toBeVisible();
    expect((await api(app, '/api/env'))[key].is_set).toBe(true);
    await row.getByRole('button', { name: '查看', exact: true }).click();
    await expect(row).toContainText(value);
    await row.getByRole('button', { name: '隐藏', exact: true }).click();
    await expect(row).not.toContainText(value);
    await row.getByRole('button', { name: '替换', exact: true }).click();
    await row.getByPlaceholder('输入值…').fill(value + '-cancelled');
    await row.getByRole('button', { name: '取消', exact: true }).click();
    await row.getByRole('button', { name: '查看', exact: true }).click();
    await expect(row).toContainText(value);
    await expect(row).not.toContainText(value + '-cancelled');
    await row.getByRole('button', { name: '隐藏', exact: true }).click();
    await row.getByRole('button', { name: '替换', exact: true }).click();
    await row.getByPlaceholder('输入值…').fill(value + '-replaced');
    await row.getByRole('button', { name: '保存', exact: true }).click();
    await row.getByRole('button', { name: '查看', exact: true }).click();
    await expect(row).toContainText(value + '-replaced');
  } finally {
    const remove = row.getByRole('button', { name: '删除', exact: true });
    if (await remove.isVisible()) await remove.click();
    await expect.poll(async () => (await api(app, '/api/env'))[key].is_set).toBe(false);
  }
});
