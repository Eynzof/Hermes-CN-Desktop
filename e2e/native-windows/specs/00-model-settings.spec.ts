import { test, expect, route, deepseekKey, baseline } from '../fixtures';

test('MODEL-001 保存 DeepSeek 凭证并通过官方连接探测', async ({ app }) => {
  const browse = app.getByRole('button', { name: '先看看界面', exact: true });
  if (await browse.isVisible()) await browse.click();
  await route(app, '/models');
  await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
  await app.getByRole('textbox', { name: 'DEEPSEEK_API_KEY', exact: true }).fill(deepseekKey());
  await app.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseline.baseUrl);
  await app.getByRole('combobox', { name: '模型', exact: true }).fill(baseline.model);
  await app.getByRole('combobox', { name: '模型', exact: true }).press('Enter');
  await app.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('1048576');
  await app.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(app.getByRole('button', { name: '测试连接', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(app.getByText(/✓ 连接成功 · 延迟/)).toBeVisible({ timeout: 60_000 });
  await route(app, '/');
  await route(app, '/models');
  await expect(app.getByText('需要先完成模型初始化', { exact: true })).toHaveCount(0);
  await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
  await expect(app.getByRole('textbox', { name: 'Base URL', exact: true })).toHaveValue(baseline.baseUrl);
  await expect(app.getByRole('combobox', { name: '模型', exact: true })).toHaveValue(baseline.model);
});
