import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, route, api, chat, bridge, switchProfile, removeProfile, home, deepseekKey, baseline } from '../fixtures';

test('PROF-004 空白档案无密钥和历史继承、独立配置真实模型及删除', async ({ app }, testInfo) => {
  const name = `blank-${Date.now()}`;
  const defaultEnvHash = createHash('sha256').update(readFileSync(path.join(home, '.env'))).digest('hex');
  const original = await chat(app, '这是默认档案的隔离测试消息，请只回复 DEFAULT-ONLY。', 'DEFAULT-ONLY');
  await route(app, '/profiles');
  await app.getByRole('button', { name: '新建档案', exact: true }).click();
  const dialog = app.getByRole('dialog');
  await dialog.getByPlaceholder('例如 work / sandbox').fill(name);
  await dialog.getByRole('combobox').first().selectOption('');
  await dialog.getByRole('button', { name: '高级选项', exact: true }).click();
  await expect(dialog.getByRole('checkbox', { name: /连同记忆和会话/ })).toBeDisabled();
  await dialog.getByRole('button', { name: '创建', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  try {
    const profileHome = path.join(home, 'profiles', name);
    expect(readFileSync(path.join(profileHome, '.env'), 'utf8')).not.toContain(deepseekKey());
    await switchProfile(app, name);
    const browse = app.getByRole('button', { name: '先看看界面', exact: true });
    if (await browse.isVisible()) await browse.click();
    expect((await api(app, '/api/sessions?limit=100')).sessions.some((session: any) => session.id === original.evidence.session.id)).toBe(false);
    await route(app, '/models');
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    const key = app.getByRole('textbox', { name: 'DEEPSEEK_API_KEY', exact: true });
    await expect(key).toHaveValue('');
    await expect(app.getByRole('button', { name: '测试连接', exact: true })).toBeDisabled();
    await app.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseline.baseUrl);
    const model = app.getByRole('combobox', { name: '模型', exact: true });
    await model.fill(baseline.model);
    await model.press('Enter');
    await app.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('1048576');
    await key.fill(deepseekKey());
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => readFileSync(path.join(profileHome, '.env'), 'utf8').includes(deepseekKey())).toBe(true);
    if ((await api(app, '/api/model/info')).provider !== 'deepseek') await app.getByRole('button', { name: '设为当前模型', exact: true }).click();
    const blank = await chat(app, '这是空白档案独立配置后的真实请求，请只回复 BLANK-PROFILE-READY。', 'BLANK-PROFILE-READY');
    expect(blank.evidence.session.profile_name).toBe(name);
    expect(blank.evidence.session.billing_provider).toBe('deepseek');
    await switchProfile(app, 'default');
    expect((await api(app, '/api/sessions?limit=100')).sessions.some((session: any) => session.id === blank.evidence.session.id)).toBe(false);
    expect(createHash('sha256').update(readFileSync(path.join(home, '.env'))).digest('hex')).toBe(defaultEnvHash);
    await testInfo.attach('isolated-profile-sessions', { body: JSON.stringify({ default: original.evidence.session, blank: blank.evidence.session, defaultCredentialFileUnchanged: true }, null, 2), contentType: 'application/json' });
  } finally {
    if ((await bridge<any>(app, 'getRuntimeInfo')).process.currentProfile !== 'default') await switchProfile(app, 'default');
    await removeProfile(app, name);
    await app.reload();
  }
});
