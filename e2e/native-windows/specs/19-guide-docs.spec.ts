import { test, expect, route, native, bridge, chat } from '../fixtures';

test('WANDER-007 API 三个章节、表格和全部代码示例复制', async ({ app }) => {
  await route(app, '/wander-memory/api');
  for (const tab of ['REST reference', 'WebSocket protocol', 'connecting the backend']) {
    await app.getByRole('tab', { name: tab, exact: true }).click();
    await expect(app.getByRole('tab', { name: tab, exact: true })).toHaveAttribute('aria-selected', 'true');
    const blocks = app.getByRole('main').locator('div').filter({ has: app.locator(':scope > pre') });
    expect(await blocks.count()).toBeGreaterThan(0);
    for (const block of await blocks.all()) {
      const expected = await block.locator('pre').innerText();
      await block.getByRole('button', { name: 'copy', exact: true }).click();
      expect((await native({ action: 'clipboard' })).text.replaceAll('\r\n', '\n')).toBe(expected.replaceAll('\r\n', '\n'));
    }
    if (tab === 'REST reference') await expect(app.getByRole('cell', { name: '/v1/memories/{id}', exact: true })).toHaveCount(2);
    if (tab === 'WebSocket protocol') await expect(app.getByRole('cell', { name: 'context.build', exact: true })).toBeVisible();
  }
});

test('SHELL-002 重新打开引导、已有连接分支返回与开箱即用完成', async ({ app }) => {
  await route(app, '/connection');
  await app.getByRole('button', { name: '重新运行使用引导', exact: true }).click();
  await expect(app.getByRole('heading', { name: '你想怎么开始使用 Hermes？', exact: true })).toBeVisible();
  await app.getByRole('button', { name: /连接已有 Hermes 仅当/ }).click();
  await expect(app.getByRole('heading', { name: '连接你已有的 Hermes', exact: true })).toBeVisible();
  await app.getByRole('button', { name: '返回重新选择', exact: true }).click();
  await expect(app.getByRole('heading', { name: '连接你已有的 Hermes', exact: true })).toBeHidden();
  await app.getByRole('button', { name: /推荐 开箱即用/ }).click();
  await expect(app).toHaveURL(/#\/models$/);
  await app.waitForFunction(() => Boolean((window as any).hermesDesktop?.getRuntimeInfo) && (window as any).__HERMES_RUNTIME__?.backendReady);
  await expect.poll(async () => (await bridge<any>(app, 'getRuntimeInfo')).guideState).toBe('completed');
  await chat(app, '这是完成引导后的连通测试，请只回复 GUIDE-READY。', 'GUIDE-READY');
});
