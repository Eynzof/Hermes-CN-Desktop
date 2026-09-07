import { test, expect, route, native } from '../fixtures';

test('SKILL-003 技能市场目录说明及全部外链打开真实系统浏览器', async ({ app }, testInfo) => {
  await route(app, '/skills');
  await app.getByRole('tab', { name: 'Skill 市场', exact: true }).click();
  await expect(app.getByRole('heading', { name: '好用的 Skill 去哪找？' })).toBeVisible();
  await expect(app.getByRole('main')).toContainText('按对方页面说明安装到当前 Hermes 环境');
  const entries = [
    ['虾评', 'https://xiaping.coze.com/'],
    ['SkillHub', 'https://skillhub.cn/skills'],
    ['Skills.sh', 'https://www.skills.sh/'],
    ['SkillsMP', 'https://skillsmp.com/zh'],
  ];
  const observed: any[] = [];
  for (const [name, url] of entries) {
    const card = app.getByRole('link').filter({ has: app.getByRole('heading', { name, exact: true }) });
    await expect(card).toHaveAttribute('href', url);
    await expect(card).toContainText('去');
    await card.click();
    let external: any;
    let address = '';
    await expect.poll(async () => {
      const windows = (await native({ action: 'systemWindows' })).windows.filter((w: any) => w.type === 'Chrome_WidgetWin_1' && w.text.endsWith(' - Google Chrome') && w.text !== 'about:blank - Google Chrome');
      for (const window of windows) {
        await native({ action: 'externalKeys', window: window.text, windowClass: window.type, windowHandle: window.handle, keys: '^l^c{ESC}' });
        address = (await native({ action: 'clipboard' })).text;
        // Skills.sh redirects its www hostname to the same official apex.
        const normalize = (value: string) => value.replace('://www.', '://').replace(/\/$/, '').toLowerCase();
        if (normalize(address) === normalize(url)) { external = window; return true; }
      }
      return false;
    }, { timeout: 30_000 }).toBe(true);
    observed.push({ name, expected: url, actual: address, window: external });
    const shot = await native({ action: 'screenshot' });
    await testInfo.attach(`market-${name}`, { path: shot.path, contentType: 'image/png' });
    await native({ action: 'externalKeys', window: external.text, windowClass: external.type, windowHandle: external.handle, keys: '^w' });
  }
  await testInfo.attach('market-native-addresses', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });
});
