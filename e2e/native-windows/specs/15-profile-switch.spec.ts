import { test, expect, route, chat, api, bridge, switchProfile, removeProfile } from '../fixtures';

test('PROF-002 克隆档案切换、配置可用、记忆隔离及切回后继续聊天', async ({ app }, testInfo) => {
  const name = `switch-${Date.now()}`;
  const marker = `default-only-${Date.now()}`;
  await route(app, '/profiles');
  await app.getByRole('button', { name: '新建档案', exact: true }).click();
  await app.getByRole('dialog').getByPlaceholder('例如 work / sandbox').fill(name);
  await app.getByRole('dialog').getByRole('combobox').first().selectOption('default');
  await app.getByRole('dialog').getByRole('button', { name: '创建', exact: true }).click();
  await expect(app.getByRole('button', { name: `${name} 的操作` })).toBeVisible();
  try {
    await route(app, '/memory');
    await app.getByRole('button', { name: '添加记忆', exact: true }).click();
    await app.getByPlaceholder('例如：用户偏好使用 TypeScript，修改前先跑 typecheck。').fill(marker);
    await app.getByRole('button', { name: '保存', exact: true }).click();
    await expect(app.locator('article').filter({ hasText: marker })).toBeVisible();
    const before = await bridge<any>(app, 'getRuntimeInfo');
    await switchProfile(app, name);
    const after = await bridge<any>(app, 'getRuntimeInfo');
    expect(after.process.pid).not.toBe(before.process.pid);
    expect(after.process.hermesHome).toContain(name);
    const model = await api(app, '/api/model/info');
    await testInfo.attach('profile-model', { body: JSON.stringify(model, null, 2), contentType: 'application/json' });
    expect.soft(model.model).toBe('deepseek-v4-flash');
    expect.soft(model.provider).toBe('deepseek');
    expect((await bridge<any>(app, 'readMemory')).memory.entries.some((m: any) => m.content === marker)).toBe(false);
    await switchProfile(app, 'default');
    expect((await bridge<any>(app, 'readMemory')).memory.entries.some((m: any) => m.content === marker)).toBe(true);
    // Do not reload here: continuing after the promised automatic reconnect is
    // the behavior under test, including the version-check gate regression.
    await chat(app, '这是切回原档案后的可用性测试，请只回复 PROFILE-RETURN-OK。', 'PROFILE-RETURN-OK');
  } finally {
    if ((await bridge<any>(app, 'getRuntimeInfo')).process.currentProfile !== 'default') await switchProfile(app, 'default');
    await removeProfile(app, name);
    await route(app, '/memory');
    const card = app.locator('article').filter({ hasText: marker });
    if (await card.count()) {
      await card.getByRole('button', { name: '', exact: true }).click();
      await card.getByRole('button', { name: '是', exact: true }).click();
    }
    // Recovery is outside the asserted workflow and does not turn its failure
    // into a pass. Restore a usable application for the next independent case.
    await app.reload();
  }
});
