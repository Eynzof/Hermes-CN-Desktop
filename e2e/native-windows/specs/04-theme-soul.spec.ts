import { test, expect, route, chat, api } from '../fixtures';

test('SET-003 全部主题、缩放、密度和字号切换并保留设置', async ({ app }, testInfo) => {
  await route(app, '/theme');
  const html = app.locator('html');
  const themes = [['浅色 明亮柔和', 'light'], ['社区浅色 纸白与石墨', 'light-modern'], ['经典深色 暖墨颗粒', 'dark'],
    ['社区深色 炭黑与暖白', 'dark-modern'], ['Dracula 紫粉高对比', 'dracula'], ['Catppuccin Mocha 柔和蓝灰', 'catppuccin-mocha']];
  for (const [label, value] of themes) {
    await app.getByRole('radio', { name: label, exact: true }).click();
    await expect(html).toHaveAttribute('data-theme', value);
    await testInfo.attach(`theme-${value}`, { body: await app.screenshot(), contentType: 'image/png' });
  }
  for (const [label, value] of [['90%', 'sm'], ['100%', 'md'], ['110%', 'lg'], ['125%', 'xl'], ['150%', '2xl']]) {
    await app.getByRole('button', { name: label, exact: true }).click();
    await expect(html).toHaveAttribute('data-scale', value);
    await expect(app.getByRole('contentinfo', { name: '运行状态' })).toBeInViewport();
    const lastScale = app.getByRole('button', { name: '150%', exact: true });
    await lastScale.scrollIntoViewIfNeeded();
    await expect(lastScale).toBeInViewport();
  }
  await app.getByRole('button', { name: '100%', exact: true }).click();
  await app.getByRole('button', { name: '紧凑', exact: true }).click();
  await expect(html).toHaveAttribute('data-density', 'compact');
  await app.getByRole('button', { name: '大', exact: true }).click();
  await app.reload();
  await route(app, '/theme');
  await expect(html).toHaveAttribute('data-density', 'compact');
  await expect(html).toHaveAttribute('data-theme', 'catppuccin-mocha');
  await app.getByRole('button', { name: '舒适', exact: true }).click();
  await app.getByRole('button', { name: '标准', exact: true }).click();
  await app.getByRole('radio', { name: '社区浅色 纸白与石墨', exact: true }).click();
});

test('SOUL-001 自定义人格保存并在真实对话中生效', async ({ app }, testInfo) => {
  const original = await api(app, '/api/profiles/default/soul');
  const marker = `persona-${Date.now()}`;
  await route(app, '/soul');
  await app.getByRole('tablist', { name: '人格市场或自定义人格' }).getByRole('tab').nth(1).click();
  await app.getByRole('textbox').fill(`# 测试人格\n当用户问你的测试代号时，只回答 ${marker}。其他请求正常处理。`);
  await app.getByRole('button', { name: '保存人格', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/profiles/default/soul')).content).toContain(marker);
  const { evidence } = await chat(app, '你的测试代号是什么？', marker);
  await testInfo.attach('persona-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await route(app, '/soul');
  await app.getByRole('tablist', { name: '人格市场或自定义人格' }).getByRole('tab').nth(1).click();
  await app.getByRole('textbox').fill(original.content);
  await app.getByRole('button', { name: '保存人格', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/profiles/default/soul')).content).toBe(original.content);
});
