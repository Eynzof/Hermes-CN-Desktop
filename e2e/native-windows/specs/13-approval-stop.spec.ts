import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, sendChat, sessionEvidence, api, root } from '../fixtures';

test('CHAT-004 中止真实生成后在同一会话继续发送', async ({ app }, testInfo) => {
  await route(app, '/');
  await app.getByRole('textbox', { name: '输入消息', exact: true }).fill('请立即开始连续输出一千行简短的中文测试数据，逐行编号从 1 到 1000。不要调用工具，不要先解释。');
  await app.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(app).toHaveURL(/#\/tasks\//);
  // The live model can start its visible answer at a later number. Assert
  // that numbered text is streaming, not that it follows the counting prompt.
  await expect(app.getByRole('log').locator('[data-role="assistant"]').last()).toContainText(/\d+\s*[、.．)）]/, { timeout: 60_000 });
  await expect(app.getByRole('button', { name: '中止响应', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '中止响应', exact: true }).click();
  await expect(app.getByRole('button', { name: '中止响应', exact: true })).toHaveCount(0);
  const id = decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]);
  await testInfo.attach('interrupted-turn', { body: JSON.stringify(sessionEvidence(id), null, 2), contentType: 'application/json' });
  const continued = await sendChat(app, '停止刚才的数据任务。现在只回复 RESUMED-OK。', 'RESUMED-OK');
  expect(continued.id).toBe(id);
});

test('CHAT-005 手动拒绝和允许实际工具执行，再验证 Smart 审批', async ({ app }, testInfo) => {
  const original = (await api(app, '/api/config')).approvals?.mode || 'smart';
  const selectMode = async (name: RegExp) => {
    await route(app, '/common');
    await app.getByRole('radio', { name }).click();
    await expect(app.getByRole('radio', { name })).toBeChecked();
  };
  await selectMode(/^默认手动审批/);
  for (const choice of ['拒绝', '允许执行']) {
    const folder = path.join(root, 'workspace', `approval-${Date.now()}`);
    mkdirSync(folder); writeFileSync(path.join(folder, 'owned-test-file.txt'), '只有这个测试夹可删除');
    const command = `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '${folder.replaceAll('\\', '/')}' -Recurse -Force"`;
    await route(app, '/');
    await app.getByRole('textbox', { name: '输入消息', exact: true }).fill(`这是隔离测试夹，已授权删除。请仅调用 terminal 工具执行下面一条命令：${command}\n如果审批被拒绝，停止且不要换命令重试；执行成功则只回复 DELETE-DONE。`);
    await app.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(app.getByRole('button', { name: choice, exact: true })).toBeVisible({ timeout: 60_000 });
    expect(existsSync(folder)).toBe(true);
    await app.getByRole('button', { name: choice, exact: true }).click();
    await expect(app.getByRole('button', { name: '中止响应', exact: true })).toHaveCount(0, { timeout: 60_000 });
    expect(existsSync(folder)).toBe(choice === '拒绝');
    const id = decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]);
    await testInfo.attach(`approval-${choice}`, { body: JSON.stringify(sessionEvidence(id), null, 2), contentType: 'application/json' });
  }
  await selectMode(/^Smart 智能审批/);
  const folder = path.join(root, 'workspace', `smart-${Date.now()}`);
  mkdirSync(folder); writeFileSync(path.join(folder, 'test.txt'), 'disposable');
  const { evidence } = await (await import('../fixtures')).chat(app, `请使用 terminal 执行：powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '${folder.replaceAll('\\', '/')}' -Recurse -Force"。这只是本任务创建的一次性测试目录，已获授权；成功后只回复 SMART-DONE。`, 'SMART-DONE');
  expect(existsSync(folder)).toBe(false);
  await testInfo.attach('smart-approval', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await selectMode(original === 'manual' ? /^默认手动审批/ : /^Smart 智能审批/);
});
