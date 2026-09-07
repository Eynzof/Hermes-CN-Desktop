import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, native, root } from '../fixtures';

test('PTY-003 原生窗口改变尺寸后 ConPTY 实际行列变化和输出保留', async ({ app }, testInfo) => {
  const window = (await native({ action: 'windows' })).windows.find((w: any) => w.class === 'Tauri Window');
  const marker = `resize-${Date.now()}`;
  await app.evaluate(() => {
    (window as any).__resizeEvents = [];
    (window as any).__resizeOff = (window as any).hermesDesktop.onTerminalOutput((event: any) => (window as any).__resizeEvents.push(event));
  });
  try {
    await native({ action: 'windowState', window: window.name, state: 'normal' });
    await route(app, '/console');
    await expect(app.getByRole('button', { name: '关闭终端', exact: true })).toBeEnabled({ timeout: 30_000 });
    const input = app.locator('.xterm-helper-textarea');
    const command = async (text: string) => { await input.focus(); await input.pressSequentially(text, { delay: 1 }); await input.press('Enter'); };
    const size = async (suffix: string) => {
      const file = path.join(root, 'workspace', marker + suffix + '.json');
      await command(`powershell -NoProfile -Command "$Host.UI.RawUI.WindowSize | ConvertTo-Json -Compress" > "${file}"`);
      await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').trim().endsWith('}')).toBe(true);
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    };
    await command(`echo BEFORE-${marker}`);
    const before = await size('-normal');
    const normalScreen = await app.locator('.xterm-screen').boundingBox();
    await native({ action: 'windowState', window: window.name, state: 'maximized' });
    await expect.poll(async () => (await app.locator('.xterm-screen').boundingBox())?.width).toBeGreaterThan(normalScreen!.width);
    const after = await size('-maximized');
    expect(after.Width).toBeGreaterThan(before.Width);
    expect(after.Height).toBeGreaterThanOrEqual(before.Height);
    await command(`echo AFTER-${marker}`);
    const output = () => app.evaluate(() => (window as any).__resizeEvents.filter((e: any) => e.kind === 'data').map((e: any) => e.data).join(''));
    await expect.poll(output).toContain(`AFTER-${marker}`);
    expect(await output()).toContain(`BEFORE-${marker}`);
    await testInfo.attach('real-conpty-dimensions', { body: JSON.stringify({ before, after, terminalOutput: await output() }, null, 2), contentType: 'application/json' });
  } finally {
    if (await app.getByRole('button', { name: '关闭终端', exact: true }).isEnabled()) await app.getByRole('button', { name: '关闭终端', exact: true }).click();
    await app.evaluate(() => (window as any).__resizeOff());
    await native({ action: 'windowState', window: window.name, state: window.maximized ? 'maximized' : 'normal' });
  }
});
