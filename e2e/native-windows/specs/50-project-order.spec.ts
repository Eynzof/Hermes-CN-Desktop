import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, sendChat, nativeDialog, root } from '../fixtures';

test('PROJ-003 项目按真实会话最近活动排序并在重载后保持', async ({ app }, testInfo) => {
  const prefix = `project-order-${Date.now()}`;
  const names = [`${prefix}-a`, `${prefix}-b`];
  const sessions: any[] = [];
  const added: string[] = [];
  try {
    for (const name of names) {
      const folder = path.join(root, 'workspace', name);
      mkdirSync(folder);
      writeFileSync(path.join(folder, 'keep.txt'), name);
      await route(app, '/projects');
      await app.getByRole('button', { name: '添加项目', exact: true }).first().click();
      await nativeDialog('选择工作区', folder);
      added.push(name);
      await app.getByPlaceholder('按名称或路径搜索…').fill(name);
      await app.getByRole('row').filter({ hasText: name }).click();
      await app.getByRole('button', { name: '新对话', exact: true }).click();
      const result = await sendChat(app, `不要调用任何工具，只回复 ${name}。`, name);
      expect(result.evidence.messages.filter((m: any) => m.role === 'tool')).toHaveLength(0);
      sessions.push({ route: new URL(app.url()).hash.slice(1), evidence: result.evidence });
    }
    const assertOrder = async (expected: string[]) => {
      await route(app, '/projects');
      await app.getByPlaceholder('按名称或路径搜索…').fill(prefix);
      await expect(app.getByText('排序 · 最近活动 ↓', { exact: true })).toBeVisible();
      const rows = app.locator('tbody tr');
      await expect(rows).toHaveCount(2);
      for (let i = 0; i < expected.length; i++) await expect(rows.nth(i)).toContainText(expected[i]);
    };
    await assertOrder([names[1], names[0]]);
    await route(app, sessions[0].route);
    const updated = await sendChat(app, `不要调用任何工具，只回复 UPDATED-${prefix}。`, `UPDATED-${prefix}`);
    expect(updated.evidence.session.id).toBe(sessions[0].evidence.session.id);
    await assertOrder([names[0], names[1]]);
    await app.reload();
    await app.getByPlaceholder('按名称或路径搜索…').fill(prefix);
    await expect(app.locator('tbody tr').first()).toContainText(names[0]);
    await testInfo.attach('project-activity-sessions', { body: JSON.stringify({ initial: sessions, updated: updated.evidence }, null, 2), contentType: 'application/json' });
  } finally {
    for (const name of added) {
      await route(app, '/projects');
      await app.getByPlaceholder('按名称或路径搜索…').fill(name);
      const row = app.getByRole('row').filter({ hasText: name });
      await row.getByRole('button', { name: '项目操作' }).click();
      await app.getByRole('menuitem', { name: '删除项目' }).click();
      await app.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
      await expect(row).toHaveCount(0);
      expect(readFileSync(path.join(root, 'workspace', name, 'keep.txt'), 'utf8')).toBe(name);
    }
  }
});
