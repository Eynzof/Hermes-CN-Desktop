import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, nativeDialog, sessionEvidence, root } from '../fixtures';

test('HIST-002 会话原生导出、取消、批量选择和删除', async ({ app }, testInfo) => {
  const prefix = `bulk-${Date.now()}`;
  const ids: string[] = [];
  for (const suffix of ['one', 'two']) {
    const { evidence } = await chat(app, `请只回复 ${prefix}-${suffix}`, `${prefix}-${suffix}`);
    ids.push(evidence.session.id);
    await route(app, '/history');
    await app.getByRole('main').getByRole('searchbox').fill(evidence.session.id);
    await app.getByRole('main').getByRole('button', { name: '会话操作', exact: true }).click();
    await app.getByRole('menuitem', { name: '重命名', exact: true }).click();
    await app.getByRole('dialog').getByRole('textbox').fill(`${prefix}-${suffix}`);
    await app.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
    await expect.poll(() => sessionEvidence(evidence.session.id).session.title).toBe(`${prefix}-${suffix}`);
  }
  const main = app.getByRole('main');
  const search = main.getByRole('searchbox');
  await search.fill(ids[0]);
  const exportMenu = async () => {
    await main.getByRole('button', { name: '会话操作', exact: true }).click();
    await app.getByRole('menuitem', { name: '导出 JSON', exact: true }).click();
  };
  await exportMenu();
  await nativeDialog('导出 Hermes 会话');
  const destination = path.join(root, 'reports', `${prefix}.json`);
  await exportMenu();
  await nativeDialog('导出 Hermes 会话', destination);
  await expect.poll(() => { try { return JSON.parse(readFileSync(destination, 'utf8')); } catch { return null; } }).not.toBeNull();
  const exported = JSON.parse(readFileSync(destination, 'utf8'));
  expect(JSON.stringify(exported)).toContain(`${prefix}-one`);
  expect(JSON.stringify(exported)).toContain(ids[0]);
  await testInfo.attach('exported-session', { path: destination, contentType: 'application/json' });
  await search.fill(prefix);
  await expect(main.locator('[data-status]')).toHaveCount(2);
  await main.getByRole('button', { name: '批量删除', exact: true }).click();
  await main.getByRole('button', { name: '退出批量删除', exact: true }).click();
  await expect(main.getByRole('checkbox')).toHaveCount(0);
  await main.getByRole('button', { name: '批量删除', exact: true }).click();
  await main.getByRole('button', { name: '选择当前筛选结果', exact: true }).click();
  await expect(main.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await main.getByRole('button', { name: '清空选择', exact: true }).click();
  await expect(main.getByRole('checkbox', { checked: true })).toHaveCount(0);
  await main.getByRole('button', { name: '选择当前筛选结果', exact: true }).click();
  await main.getByRole('button', { name: '删除所选', exact: true }).click();
  await app.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  for (const id of ids) expect(sessionEvidence(id).session).not.toBeNull();
  await main.getByRole('button', { name: '删除所选', exact: true }).click();
  await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(main.locator('[data-status]')).toHaveCount(0);
  for (const id of ids) await expect.poll(() => sessionEvidence(id).session).toBeNull();
  await expect(main.getByRole('button', { name: '批量删除', exact: true })).toBeVisible();
});
