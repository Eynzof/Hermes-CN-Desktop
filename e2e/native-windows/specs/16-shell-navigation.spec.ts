import { test, expect, route, native, chat, baseline } from '../fixtures';

test('SHELL-001 主导航、侧栏切换、命令搜索、键盘导航和会话搜索', async ({ app }) => {
  await route(app, '/');
  await app.getByRole('button', { name: '隐藏左侧边栏', exact: true }).click();
  await expect(app.getByRole('button', { name: '显示左侧边栏', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '显示左侧边栏', exact: true }).click();
  await expect(app.getByRole('button', { name: '隐藏左侧边栏', exact: true })).toBeVisible();
  const mainLinks = [['02 配置', '/models'], ['03 消息接入', '/im/feishu'], ['04 Wander 记忆', '/wander-memory/memories'], ['05 Hermes 记忆', '/memory'], ['06 高级', '/health'], ['01 工作台', '/']];
  for (const [name, target] of mainLinks) {
    await app.getByRole('navigation', { name: '主导航' }).getByRole('link', { name, exact: true }).click();
    await expect.poll(() => new URL(app.url()).hash).toBe(`#${target}`);
  }
  await app.keyboard.press('Control+k');
  const dialog = app.getByRole('dialog', { name: '全局命令面板', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('搜索命令、会话、项目、文件或 Skill…').fill('数据分析');
  await dialog.getByRole('option').filter({ hasText: '数据分析' }).click();
  await expect(app).toHaveURL(/#\/analytics$/);
  await app.keyboard.press('Control+k');
  await dialog.getByPlaceholder('搜索命令、会话、项目、文件或 Skill…').fill('no-matching-command-unique');
  await expect(dialog.getByText('没有匹配的命令或内容', { exact: true })).toBeVisible();
  await app.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const marker = `palette-${Date.now()}`;
  const { evidence } = await chat(app, `请只回复 ${marker}`, marker);
  await route(app, '/health');
  await app.keyboard.press('Control+k');
  await dialog.getByPlaceholder('搜索命令、会话、项目、文件或 Skill…').fill(marker);
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await app.keyboard.press('Enter');
  await expect(app).toHaveURL(new RegExp(`#/tasks/${evidence.session.id}`));
  await expect(app.getByRole('log')).toContainText(marker);
});

test('ENV-001 原生环境重新检测、分类和诊断来源核对', async ({ app }, testInfo) => {
  await route(app, '/env');
  await app.getByRole('button', { name: '刷新检查', exact: true }).click();
  await expect(app.getByRole('button', { name: '刷新检查', exact: true })).toBeEnabled({ timeout: 60_000 });
  await app.getByRole('button', { name: '复制诊断 JSON', exact: true }).click();
  const diagnostics = JSON.parse((await native({ action: 'clipboard' })).text);
  const serialized = JSON.stringify(diagnostics);
  expect(serialized).toContain('C:\\\\HermesE2E\\\\runtime');
  expect(serialized).toContain('0.21.0-cn.3');
  await expect(app.getByRole('heading', { name: '核心环境正常', exact: true })).toBeVisible();
  for (const title of ['核心环境', '本机内核', '本机工具', '浏览器能力', '路径']) await expect(app.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await testInfo.attach('environment-diagnostics', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
});

test('ABOUT-001 版本来源、更新检查和联系方式复制', async ({ app }, testInfo) => {
  await route(app, '/about');
  await expect(app.getByRole('main')).toContainText(`v${baseline.desktopVersion}`);
  await app.getByRole('main').getByRole('button', { name: '复制', exact: true }).click();
  expect((await native({ action: 'clipboard' })).text).toBe('hello@wanderminds.ai');
  await app.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(app.getByRole('button', { name: '检查更新', exact: true })).toBeEnabled({ timeout: 60_000 });
  await expect(app.getByRole('main')).toContainText(/当前已是最新版本 v[\d.]+。|发现新版本 v[\d.]+/);
  await testInfo.attach('actual-update-check', { body: await app.getByRole('main').ariaSnapshot(), contentType: 'text/plain' });
});
