import { test, expect, route, native, chat } from '../fixtures';

test('SET-001 助手名称头像、推理显示、发送快捷键与重载持久化', async ({ app }) => {
  const name = `测试助手-${Date.now()}`;
  await route(app, '/common');
  const original = await app.getByPlaceholder('Hermes', { exact: true }).inputValue();
  await app.getByPlaceholder('Hermes', { exact: true }).fill(name);
  await app.getByRole('button', { name: '显示', exact: true }).click();
  await app.getByRole('button', { name: 'Ctrl+Enter 发送', exact: true }).click();
  const chooser = app.waitForEvent('filechooser');
  await app.getByRole('button', { name: '上传', exact: true }).click();
  await (await chooser).setFiles({ name: 'test-avatar.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#2677aa"/></svg>') });
  await expect(app.getByAltText('Hermes 头像预览')).toBeVisible();
  await route(app, '/');
  const input = app.getByRole('textbox', { name: '输入消息', exact: true });
  await input.fill('第一行');
  await input.press('Enter');
  await expect(input).toHaveValue('第一行\n');
  await expect(app).toHaveURL(/#\/$/);
  await input.fill('');
  await app.reload();
  await route(app, '/common');
  await expect(app.getByPlaceholder('Hermes', { exact: true })).toHaveValue(name);
  await expect(app.getByAltText('Hermes 头像预览')).toBeVisible();
  const marker = `display-${Date.now()}`;
  await chat(app, `只回复 ${marker}`, marker);
  await expect(app.getByRole('log').getByText(name, { exact: true })).toBeVisible();
  await route(app, '/common');
  await app.getByRole('button', { name: '移除', exact: true }).click();
  await expect(app.getByAltText('Hermes 头像预览')).toHaveCount(0);
  await app.getByPlaceholder('Hermes', { exact: true }).fill(original);
  await app.getByRole('button', { name: 'Enter 发送', exact: true }).click();
  await app.getByRole('button', { name: '隐藏', exact: true }).click();
});

test('MIGRATE-001 迁移说明复制、当前目录来源和新任务预填确认', async ({ app }) => {
  await route(app, '/config-migration');
  await app.getByRole('button', { name: '复制迁移说明', exact: true }).click();
  await expect(app.getByText('已复制迁移说明。你可以把它粘贴到任意 Hermes 对话中使用。', { exact: true })).toBeVisible();
  const prompt = (await native({ action: 'clipboard' })).text;
  expect(prompt).toContain('C:\\HermesE2E\\runtime\\hermes-home');
  expect(prompt).toContain('迁移');
  await app.getByRole('button', { name: '开始迁移向导', exact: true }).click();
  await expect(app).toHaveURL(/#\/$/);
  const normalize = (value: string) => value.replaceAll('\r\n', '\n').replace(/采集时间：[^\n]+/, '采集时间：[runtime timestamp]');
  await expect.poll(async () => normalize(await app.getByRole('textbox', { name: '输入消息', exact: true }).inputValue())).toBe(normalize(prompt));
  // The guide promises a draft for review, so starting it must not send it.
  await expect(app.getByRole('button', { name: '中止响应', exact: true })).toHaveCount(0);
  await app.getByRole('textbox', { name: '输入消息', exact: true }).fill('');
});
