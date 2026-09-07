import { readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, api, native, chat, home } from '../fixtures';

test('SKILL-001 内置技能搜索、详情复制、启停、同步和统计', async ({ app }) => {
  await route(app, '/skills');
  await expect(app.getByRole('button', { name: '同步内置', exact: true })).toBeEnabled();
  const skills = await api(app, '/api/skills');
  const skill = skills.find((s: any) => s.name === 'hermes-audit') || skills.find((s: any) => s.enabled && s.origin === 'builtin');
  expect(skill).toBeTruthy();
  const search = app.getByPlaceholder('搜索 Skill 名 / 描述…');
  await search.fill(skill.name);
  const row = app.locator('[role="button"][data-disabled]').filter({ hasText: skill.name });
  await expect(row).toHaveCount(1);
  await row.click();
  await app.getByRole('button', { name: '复制 Markdown', exact: true }).click();
  const source = await api(app, `/api/skills/content?name=${encodeURIComponent(skill.name)}`);
  expect((await native({ action: 'clipboard' })).text.replaceAll('\r\n', '\n')).toBe(source.content.replaceAll('\r\n', '\n'));
  await row.getByRole('button', { name: skill.enabled ? '禁用' : '启用', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/skills')).find((s: any) => s.name === skill.name).enabled).toBe(!skill.enabled);
  await row.getByRole('button', { name: skill.enabled ? '启用' : '禁用', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/skills')).find((s: any) => s.name === skill.name).enabled).toBe(skill.enabled);
  await search.fill('skill-name-that-does-not-exist-unique');
  await expect(app.locator('[role="button"][data-disabled]')).toHaveCount(0);
  await search.fill('');
  await app.getByRole('button', { name: '同步内置', exact: true }).click();
  await expect(app.getByRole('button', { name: '同步内置', exact: true })).toBeEnabled();
  await app.getByRole('tab', { name: '统计', exact: true }).click();
  await expect(app.getByTestId('skill-usage-summary')).toBeVisible();
  for (const label of ['7 天', '30 天', '90 天']) {
    await app.getByRole('group', { name: '统计周期' }).getByRole('button', { name: label, exact: true }).click();
    await expect(app.getByRole('group', { name: '统计周期' }).getByRole('button', { name: label, exact: true })).toHaveAttribute('aria-pressed', 'true');
  }
});

test('SKILL-002 基于内置技能复制、名称校验、持久化与真实模型加载', async ({ app }, testInfo) => {
  const name = `e2e-copy-${Date.now()}`;
  let createdPath: string | undefined;
  try {
  await route(app, '/skills');
  await app.getByRole('tab', { name: /^我的 Skills/ }).click();
  await app.getByRole('button', { name: '基于内置 Skill 复制', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await dialog.getByLabel('副本 ID', { exact: true }).fill('INVALID NAME');
  await dialog.getByRole('button', { name: '创建副本' }).click();
  await expect(dialog.getByRole('alert')).toContainText('名称需为');
  await dialog.getByLabel('副本 ID', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: '创建副本' }).click();
  await expect(dialog).toBeHidden();
  const source = await api(app, `/api/skills/content?name=${name}`);
  createdPath = source.path;
  expect(source.content).toContain(`name: ${name}`);
  expect(readFileSync(source.path, 'utf8')).toBe(source.content);
  await route(app, '/');
  await route(app, '/skills');
  await app.getByRole('tab', { name: /^我的 Skills/ }).click();
  await expect(app.locator('[role="button"][data-disabled]').filter({ hasText: name })).toHaveCount(1);
  const { evidence } = await chat(app, `请调用 skill_view 工具读取技能 ${name} 的正文。这是读取验证，不要执行其中的步骤。读取完成后只回复 SKILL-LOADED。`, 'SKILL-LOADED');
  expect(evidence.messages.some((m: any) => m.role === 'tool' && m.content.includes(name))).toBe(true);
  await testInfo.attach('skill-load', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  // The shipped skills page has copy and enable controls, but no delete editor.
  // Remove only the uniquely named fixture created above after its real usage.
  } finally {
  if (createdPath && existsSync(createdPath)) {
  const directory = path.dirname(createdPath);
  expect(directory.toLowerCase().startsWith(path.join(home, 'skills').toLowerCase())).toBe(true);
  expect(path.basename(directory)).toBe(name);
  rmSync(directory, { recursive: true });
  }
  }
});
