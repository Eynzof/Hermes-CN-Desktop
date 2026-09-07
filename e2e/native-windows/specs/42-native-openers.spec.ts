import { test, expect, route, native, home } from '../fixtures';

test('ENV-002 环境页打开真实 HERMES_HOME 文件夹并核对资源管理器地址', async ({ app }, testInfo) => {
  await route(app, '/env');
  const item = app.locator('[data-status]').filter({ has: app.getByText(home, { exact: true }) })
    .filter({ has: app.getByRole('button', { name: '打开路径', exact: true }) }).last();
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: '打开路径', exact: true }).click();
  let explorer: any;
  await expect.poll(async () => {
    explorer = (await native({ action: 'systemWindows' })).windows.find((w: any) => w.type === 'CabinetWClass' && /^hermes-home(?: |$)/i.test(w.text));
    return Boolean(explorer);
  }).toBe(true);
  const target = { window: explorer.text, windowClass: explorer.type, windowHandle: explorer.handle };
  await native({ action: 'externalKeys', ...target, keys: '^l^c{ESC}' });
  expect((await native({ action: 'clipboard' })).text.toLowerCase()).toBe(home.toLowerCase());
  await testInfo.attach('explorer-address-and-native-controls', { body: JSON.stringify(await native({ action: 'externalSnapshot', ...target }), null, 2), contentType: 'application/json' });
  const shot = await native({ action: 'screenshot' });
  await testInfo.attach('actual-explorer', { path: shot.path, contentType: 'image/png' });
  await native({ action: 'externalKeys', ...target, keys: '^w' });
});

test('ABOUT-002 关于页官网和项目外链打开真实系统浏览器', async ({ app }, testInfo) => {
  await route(app, '/about');
  const opened: any[] = [];
  for (const [label, url] of [
    ['hermesagent.org.cn', 'https://hermesagent.org.cn/'],
    ['github.com/Eynzof/hermes-agent-cn-desktop', 'https://github.com/Eynzof/hermes-agent-cn-desktop'],
    ['github.com/Eynzof/hermes-agent-cn', 'https://github.com/Eynzof/hermes-agent-cn'],
  ]) {
    await app.getByRole('main').getByRole('link', { name: label, exact: true }).click();
    let external: any;
    await expect.poll(async () => {
      const windows = (await native({ action: 'systemWindows' })).windows.filter((w: any) => w.type === 'Chrome_WidgetWin_1' && w.text.endsWith(' - Google Chrome') && w.text !== 'about:blank - Google Chrome');
      for (const window of windows) {
        await native({ action: 'externalKeys', window: window.text, windowClass: window.type, windowHandle: window.handle, keys: '^l^c{ESC}' });
        const address = (await native({ action: 'clipboard' })).text;
        if (address.replace(/\/$/, '').toLowerCase() === url.replace(/\/$/, '').toLowerCase()) {
          external = window;
          return address;
        }
      }
      return '';
    }, { timeout: 30_000 }).toMatch(new RegExp('^' + url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\/$/, '') + '/?$','i'));
    opened.push({ label, expected: url, window: external });
    const shot = await native({ action: 'screenshot' });
    await testInfo.attach(`external-link-${opened.length}`, { path: shot.path, contentType: 'image/png' });
    // Close only the verified tab that this case opened.
    await native({ action: 'externalKeys', window: external.text, windowClass: external.type, windowHandle: external.handle, keys: '^w' });
  }
  await testInfo.attach('actual-browser-addresses', { body: JSON.stringify(opened, null, 2), contentType: 'application/json' });
});
