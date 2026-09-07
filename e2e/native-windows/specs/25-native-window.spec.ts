import { test, expect, native, chat } from '../fixtures';

test('SHELL-004 原生最小化恢复、最大化、关闭到托盘与托盘恢复', async ({ app }, testInfo) => {
  const main = (await native({ action: 'windows' })).windows.find((w: any) => w.class === 'Tauri Window');
  await native({ action: 'windowState', window: main.name, state: 'normal' });
  const normalSize = await app.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  await native({ action: 'windowState', window: main.name, state: 'maximized' });
  await expect.poll(async () => (await app.evaluate(() => innerWidth)) > normalSize.width).toBe(true);
  await native({ action: 'windowState', window: main.name, state: 'minimized' });
  await expect.poll(async () => (await native({ action: 'windows' })).windows.find((w: any) => w.class === 'Tauri Window')?.minimized).toBe(true);
  await native({ action: 'windowState', window: main.name, state: 'normal' });
  await native({ action: 'activate', window: main.name });
  await expect.poll(async () => (await native({ action: 'windows' })).windows.find((w: any) => w.class === 'Tauri Window')?.minimized).toBe(false);
  await native({ action: 'keys', window: main.name, keys: '%{F4}' });
  await expect.poll(async () => (await native({ action: 'windows' })).windows.some((w: any) => w.class === 'Tauri Window')).toBe(false);
  const shell = await native({ action: 'shellSnapshot' });
  const overflowOpen = shell.windows.some((w: any) => w.window.class === 'TopLevelWindowForOverflowXamlIsland' && !w.window.offscreen);
  if (!overflowOpen) await native({ action: 'shellClick', shellClass: 'Shell_TrayWnd', controlName: '显示隐藏的图标' });
  await expect.poll(async () => (await native({ action: 'shellSnapshot' })).windows.flatMap((w: any) => w.controls).some((c: any) => c.name === 'Hermes Agent 中文社区桌面版')).toBe(true);
  await native({ action: 'shellClick', shellClass: 'TopLevelWindowForOverflowXamlIsland', controlName: 'Hermes Agent 中文社区桌面版' });
  await expect.poll(async () => (await native({ action: 'windows' })).windows.some((w: any) => w.class === 'Tauri Window')).toBe(true);
  await native({ action: 'windowState', window: main.name, state: 'maximized' });
  await native({ action: 'activate', window: main.name });
  await chat(app, '这是从 Windows 托盘恢复后的真实对话，请只回复 TRAY-RESTORED。', 'TRAY-RESTORED');
  const shot = await native({ action: 'screenshot' });
  await testInfo.attach('tray-restored-desktop', { path: shot.path, contentType: 'image/png' });
});
