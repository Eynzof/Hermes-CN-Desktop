import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, bridge, chat, root } from '../fixtures';

test('MEM-001 记忆增改删、用户画像、容量设置及真实跨会话召回', async ({ app }, testInfo) => {
  const marker = `mem-${Date.now()}`;
  const secret = `memory-secret-${randomUUID()}`;
  const remembered = `${marker} 的端到端测试专用暗号是 ${secret}，询问该条目的暗号时只回复暗号。`;
  const original = await bridge<any>(app, 'readMemory');
  const recovery = path.join(root, 'secrets', 'memory-cases');
  mkdirSync(recovery, { recursive: true });
  writeFileSync(path.join(recovery, `${marker}.json`), JSON.stringify(original));
  const card = app.locator('article').filter({ hasText: marker });
  try {
  await route(app, '/memory');
  await app.getByRole('button', { name: '添加记忆', exact: true }).click();
  await app.getByPlaceholder('例如：用户偏好使用 TypeScript，修改前先跑 typecheck。').fill('待编辑的测试记忆 ' + marker);
  await app.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await card.getByRole('textbox').fill(remembered);
  await card.getByRole('button', { name: '保存', exact: true }).click();
  await expect(card).toContainText(remembered);
  await app.getByRole('spinbutton', { name: 'MEMORY.md 容量上限' }).fill(String(original.memory.charLimit === 2300 ? 2400 : 2300));
  await app.getByRole('button', { name: '保存上限', exact: true }).click();
  await expect(app.getByRole('button', { name: '保存上限', exact: true })).toBeDisabled();
  await app.getByRole('button', { name: /^用户画像 / }).click();
  await app.getByRole('textbox').fill(`这是 Windows 自动化测试档案，偏好简洁中文回答。 ${marker}`);
  await app.getByRole('button', { name: '保存画像', exact: true }).click();
  await expect.poll(async () => (await bridge<any>(app, 'readMemory')).user.content).toContain(marker);
  const { evidence } = await chat(app, `请根据你的长期记忆回答：${marker} 这个条目的端到端测试专用暗号是什么？只回复暗号，不要调用任何工具。`, secret);
  await testInfo.attach('recall-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await route(app, '/memory');
  await app.getByRole('button', { name: /^本地记忆 / }).click();
  await expect(card).toContainText(remembered);
  await card.getByRole('button', { name: '删除记忆', exact: true }).click();
  await card.getByRole('button', { name: '否', exact: true }).click();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: '删除记忆', exact: true }).click();
  await card.getByRole('button', { name: '是', exact: true }).click();
  await expect(card).toHaveCount(0);
  } finally {
  await route(app, '/memory');
  await app.getByRole('button', { name: /^本地记忆 / }).click();
  if (await card.count()) {
    if (!await card.getByRole('button', { name: '是', exact: true }).isVisible()) {
      await card.getByRole('button', { name: '删除记忆', exact: true }).click();
    }
    await card.getByRole('button', { name: '是', exact: true }).click();
    await expect(card).toHaveCount(0);
  }
  await app.getByRole('spinbutton', { name: 'MEMORY.md 容量上限' }).fill(String(original.memory.charLimit));
  const saveLimit = app.getByRole('button', { name: '保存上限', exact: true });
  if (await saveLimit.isEnabled()) await saveLimit.click();
  await expect.poll(async () => (await bridge<any>(app, 'readMemory')).memory.charLimit).toBe(original.memory.charLimit);
  await app.getByRole('button', { name: /^用户画像 / }).click();
  await app.getByRole('textbox').fill(original.user.content);
  const saveUser = app.getByRole('button', { name: '保存画像', exact: true });
  if (await saveUser.isEnabled()) await saveUser.click();
  await expect.poll(async () => (await bridge<any>(app, 'readMemory')).user.content).toBe(original.user.content);
  }
});
