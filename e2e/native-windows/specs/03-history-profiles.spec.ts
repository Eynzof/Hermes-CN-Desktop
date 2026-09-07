import { test, expect, route, chat, sessionEvidence, api } from '../fixtures';

test('HIST-001 历史搜索筛选、重命名、置顶、归档恢复及删除', async ({ app }) => {
  const marker = `history-${Date.now()}`;
  const { evidence } = await chat(app, `请只回复 ${marker}`, marker);
  const id = evidence.session.id;
  await route(app, '/history');
  const main = app.getByRole('main');
  const search = main.getByRole('searchbox');
  await search.fill(id);
  await expect(main.locator('[data-status]')).toHaveCount(1);
  await main.getByRole('tab', { name: /^已完成 / }).click();
  await expect(main.locator('[data-status]')).toHaveCount(1);
  const menu = async (name: string) => {
    await main.getByRole('button', { name: '会话操作', exact: true }).click();
    await app.getByRole('menuitem', { name, exact: true }).click();
  };
  await menu('重命名');
  await app.getByRole('dialog').getByRole('textbox').fill(marker);
  await app.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(() => sessionEvidence(id).session.title).toBe(marker);
  await search.fill(marker);
  await expect(main.locator('[data-status]')).toHaveCount(1);
  await menu('置顶');
  await main.getByRole('button', { name: '会话操作', exact: true }).click();
  await expect(app.getByRole('menuitem', { name: '取消置顶', exact: true })).toBeVisible();
  await app.getByRole('menuitem', { name: '取消置顶', exact: true }).click();
  await menu('归档');
  await expect(main.locator('[data-status]')).toHaveCount(0);
  await main.getByRole('tab', { name: /^已归档 / }).click();
  await expect(main.locator('[data-status]')).toHaveCount(1);
  // Desktop's Rust proxy owns archival separately from Core's state.db.
  await expect.poll(async () => (await api(app, '/api/sessions?limit=100&include_archived=true')).sessions.find((s: any) => s.id === id)?.archived).toBe(true);
  await menu('取消归档');
  await main.getByRole('tab', { name: /^活跃中 / }).click();
  await expect(main.locator('[data-status]')).toHaveCount(1);
  await menu('删除');
  await app.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(main.locator('[data-status]')).toHaveCount(1);
  await menu('删除');
  await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(main.locator('[data-status]')).toHaveCount(0);
  await expect.poll(() => sessionEvidence(id).session).toBeNull();
  await search.fill('');
});

test('PROF-001 创建克隆档案、编辑描述模型、重命名和删除', async ({ app }) => {
  const name = `e2e-${Date.now()}`;
  const renamed = name + '-renamed';
  await route(app, '/profiles');
  await app.getByRole('button', { name: '新建档案', exact: true }).click();
  let dialog = app.getByRole('dialog');
  await dialog.getByPlaceholder('例如 work / sandbox').fill(name);
  // Shipped Field labels are not associated with these two select controls.
  await dialog.getByRole('combobox').nth(0).selectOption('default');
  await dialog.getByPlaceholder('一两句话说明这个档案的角色。').fill('原生测试克隆档案');
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(app.getByRole('button', { name: `${name} 的操作` })).toBeVisible();
  const menu = async (profile: string, action: string) => {
    await app.getByRole('button', { name: `${profile} 的操作` }).click();
    await app.getByRole('menuitem', { name: action, exact: true }).click();
  };
  await menu(name, '改描述');
  await app.getByRole('dialog').getByRole('textbox').fill('仅用于 Windows E2E 的隔离档案');
  await app.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.getByText('仅用于 Windows E2E 的隔离档案', { exact: true })).toBeVisible();
  await menu(name, '改模型');
  dialog = app.getByRole('dialog');
  await expect(dialog.getByRole('combobox')).toBeEnabled();
  const selected = await dialog.getByRole('combobox').locator('option').evaluateAll(options =>
    options.find(o => o.textContent?.includes('deepseek-v4-flash') && !o.textContent?.includes('vision'))?.getAttribute('value'));
  expect(selected).toBeTruthy();
  await dialog.getByRole('combobox').selectOption(selected!);
  await dialog.getByRole('button', { name: '保存', exact: true }).click();
  await menu(name, '重命名');
  await app.getByRole('dialog').getByRole('textbox').fill(renamed);
  await app.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.getByRole('button', { name: `${renamed} 的操作` })).toBeVisible();
  const profiles = await api(app, '/api/profiles');
  expect(profiles.profiles.some((p: any) => p.name === renamed && p.model === 'deepseek-v4-flash')).toBe(true);
  await menu(renamed, '删除');
  await app.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  await expect(app.getByRole('button', { name: `${renamed} 的操作` })).toBeVisible();
  await menu(renamed, '删除');
  await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(app.getByRole('button', { name: `${renamed} 的操作` })).toHaveCount(0);
});
