import { existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test, expect, route, native, nativeDialog, bridge, api, root, home, python, chat, sendChat, switchProfile, removeProfile } from '../fixtures';

test('BACKUP-001 原生备份导出、取消、恢复到独立档案并核对数据', async ({ app }, testInfo) => {
  const marker = `backup-${Date.now()}`;
  const folder = path.join(root, 'secrets', 'backups');
  mkdirSync(folder, { recursive: true });
  const archive = path.join(folder, marker + '.zip');
  const conversation = await chat(app, `禁止调用任何工具，也不要更新记忆。请只回复备份验收标记 ${marker}`, marker);
  expect(conversation.evidence.session.tool_call_count).toBe(0);
  await route(app, '/memory');
  await app.getByRole('button', { name: '添加记忆', exact: true }).click();
  await app.getByPlaceholder('例如：用户偏好使用 TypeScript，修改前先跑 typecheck。').fill(marker);
  await app.getByRole('button', { name: '保存', exact: true }).click();
  await expect(app.locator('article').filter({ hasText: marker })).toBeVisible();
  await route(app, '/backup');
  await app.getByRole('button', { name: '导出当前档案备份', exact: true }).click();
  await nativeDialog('导出 Hermes 备份');
  await expect(app.getByText('已取消导出。', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: '导出当前档案备份', exact: true }).click();
  await nativeDialog('导出 Hermes 备份', archive);
  await expect(app.getByText('导出结果', { exact: true })).toBeVisible({ timeout: 60_000 });
  expect(existsSync(archive)).toBe(true);
  const summary = execFileSync(python, [fileURLToPath(new URL('../scripts/inspect-backup.py', import.meta.url)), archive], { encoding: 'utf8' });
  await testInfo.attach('backup-validation', { body: summary, contentType: 'application/json' });
  // sessions/ also contains request_dump JSON. File presence alone is not
  // restorable chat history; the restored session assertion below decides it.
  const shot = await native({ action: 'screenshot' });
  await testInfo.attach('native-export', { path: shot.path, contentType: 'image/png' });
  await route(app, '/memory');
  const card = app.locator('article').filter({ has: app.getByText(marker, { exact: true }) });
  await card.getByRole('button', { name: '删除记忆', exact: true }).click();
  await card.getByRole('button', { name: '是', exact: true }).click();
  await expect(card).toHaveCount(0);
  await route(app, '/backup');
  await app.getByRole('button', { name: '导入备份压缩包', exact: true }).click();
  await nativeDialog('选择 Hermes 备份压缩包');
  await expect(app.getByText('已取消导入。', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: '导入备份压缩包', exact: true }).click();
  await nativeDialog('选择 Hermes 备份压缩包', archive, '%o');
  await expect(app.getByText(/已恢复到新 profile/)).toBeVisible({ timeout: 90_000 });
  const active = await api(app, '/api/profiles/active');
  expect(active.current).not.toBe('default');
  expect((await bridge<any>(app, 'readMemory')).memory.entries.some((entry: any) => entry.content === marker)).toBe(true);
  const restoredHistory = await api(app, '/api/sessions?limit=100&include_archived=true');
  expect.soft(restoredHistory.sessions.some((session: any) => session.id === conversation.evidence.session.id), 'The conversation must remain available after restoring the backup').toBe(true);
  await testInfo.attach('restored-history', { body: JSON.stringify(restoredHistory, null, 2), contentType: 'application/json' });
  const restored = active.current;
  const restoredModel = await api(app, '/api/model/info');
  await testInfo.attach('restored-model', { body: JSON.stringify(restoredModel, null, 2), contentType: 'application/json' });
  expect.soft(restoredModel.model, 'Restored profile must retain the configured model').toBe('deepseek-v4-flash');
  expect.soft(restoredModel.provider, 'Restored profile must retain the configured provider').toBe('deepseek');
  await route(app, '/profiles');
  // Exercise the first-use dialog if restoring the profile exposed it. Its
  // appearance is recorded by the model assertions above, not silently fixed.
  const browse = app.getByRole('button', { name: '先看看界面', exact: true });
  const switchDefault = app.getByRole('button', { name: '切换到 default 档案', exact: true });
  await expect(browse.or(switchDefault).first()).toBeVisible();
  if (await browse.isVisible()) await browse.click();
  await app.getByRole('button', { name: '切换到 default 档案', exact: true }).click();
  await expect(app.getByText('正在切换档案…', { exact: true })).toBeVisible();
  await expect(app.getByText('正在切换档案…', { exact: true })).toBeHidden({ timeout: 90_000 });
  await expect.poll(async () => (await api(app, '/api/profiles/active')).current, { timeout: 90_000 }).toBe('default');
  expect((await bridge<any>(app, 'readMemory')).memory.entries.some((entry: any) => entry.content === marker)).toBe(false);
  await expect(app.getByRole('button', { name: `${restored} 的操作` })).toBeEnabled();
  await app.getByRole('button', { name: `${restored} 的操作` }).click();
  await app.getByRole('menuitem', { name: '删除', exact: true }).click();
  await app.getByRole('dialog').getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(app.getByRole('button', { name: `${restored} 的操作` })).toHaveCount(0);
  const tombstone = path.join(home, 'profiles', '.deleted', restored);
  await expect.poll(() => existsSync(tombstone)).toBe(true);
  // Restoring the same archive must reuse the deleted name and clear the
  // durable deletion marker; otherwise Core rejects the newly restored home.
  await route(app, '/backup');
  await app.getByRole('button', { name: '导入备份压缩包', exact: true }).click();
  await nativeDialog('选择 Hermes 备份压缩包', archive, '%o');
  await expect(app.getByText(/已恢复到新 profile/)).toBeVisible({ timeout: 90_000 });
  expect((await api(app, '/api/profiles/active')).current).toBe(restored);
  try {
    expect(existsSync(tombstone)).toBe(false);
    await route(app, `/tasks/${conversation.evidence.session.id}`);
    const resumed = await sendChat(app, '仅从本会话上下文回答刚才的备份验收标记，禁止调用工具。', marker);
    expect(resumed.evidence.session.id).toBe(conversation.evidence.session.id);
    await testInfo.attach('restored-deleted-profile-conversation', { body: JSON.stringify(resumed.evidence, null, 2), contentType: 'application/json' });
  } finally {
    await switchProfile(app, 'default');
    await removeProfile(app, restored);
  }
});
