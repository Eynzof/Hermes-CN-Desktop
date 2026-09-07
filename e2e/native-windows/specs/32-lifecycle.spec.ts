import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { test, expect, route, chat, sendChat, native, bridge, root, sessionEvidence } from '../fixtures';

const run = promisify(execFile);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('SHELL-003 托盘正常退出、内核退出、冷启动立即真实发送及旧会话恢复', async ({ app }, testInfo) => {
  const before = JSON.parse(readFileSync(path.join(root, 'reports', 'desktop-process.json'), 'utf8').replace(/^\uFEFF/, ''));
  const sentinel = `lifecycle-${Date.now()}`;
  const file = path.join(root, 'workspace', sentinel + '.txt');
  writeFileSync(file, sentinel);
  const history = await chat(app, `请记住当前会话的暗号 ${sentinel}，只回复 READY。`, 'READY');
  const persistedId = history.evidence.session.id;
  const core = await bridge<any>(app, 'getRuntimeInfo');
  let menu = (await native({ action: 'windows' })).windows.find((w: any) => w.class === '#32768');
  if (!menu) {
    const shell = await native({ action: 'shellSnapshot' });
    if (!shell.windows.some((w: any) => w.window.class === 'TopLevelWindowForOverflowXamlIsland' && !w.window.offscreen)) {
      await native({ action: 'shellClick', shellClass: 'Shell_TrayWnd', controlName: '显示隐藏的图标' });
    }
    await native({ action: 'shellClick', shellClass: 'TopLevelWindowForOverflowXamlIsland', controlName: 'Hermes Agent 中文社区桌面版', button: 'right' });
    await expect.poll(async () => (await native({ action: 'windows' })).windows.some((w: any) => w.class === '#32768')).toBe(true);
    menu = (await native({ action: 'windows' })).windows.find((w: any) => w.class === '#32768');
  }
  const entries = (await native({ action: 'menuItems', window: menu.name, windowHandle: menu.handle })).items;
  expect(entries.filter((item: any) => item.text).map((item: any) => item.text)).toEqual(['打开主窗口', '退出 Hermes']);
  await native({ action: 'clickMenuItem', window: menu.name, windowHandle: menu.handle, controlName: '退出 Hermes' });
  await expect.poll(() => alive(before.pid), { timeout: 30_000 }).toBe(false);
  await expect.poll(async () => {
    try { await fetch('http://127.0.0.1:9120/api/health', { signal: AbortSignal.timeout(500) }); return true; } catch { return false; }
  }, { timeout: 30_000 }).toBe(false);
  const launch = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'start.ps1'), '-Root', root], { windowsHide: true, timeout: 120_000 });
  await testInfo.attach('normal-exit-and-launch', { body: JSON.stringify({ previousDesktop: before.pid, previousCore: core.process, menu: entries, startup: launch.stdout }, null, 2), contentType: 'application/json' });
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19229');
  try {
    const fresh = browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('hermesui.localhost'))!;
    // No transport warm-up or retry. Send at the first usable composer after
    // normal launcher readiness, retaining cold-start failures as failures.
    await route(fresh, '/');
    const cold = await sendChat(fresh, '这是冷启动首条真实消息，请只回复 COLD-START-READY。', 'COLD-START-READY');
    const after = JSON.parse(readFileSync(path.join(root, 'reports', 'desktop-process.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(after.pid).not.toBe(before.pid);
    expect(readFileSync(file, 'utf8')).toBe(sentinel);
    expect(sessionEvidence(persistedId).session.id).toBe(persistedId);
    await route(fresh, `/tasks/${persistedId}`);
    await expect(fresh.getByRole('log')).toContainText('READY');
    const restored = await sendChat(fresh, '这个会话在重启前告诉你的暗号是什么？只回复暗号。', sentinel);
    expect(restored.evidence.session.id).toBe(persistedId);
    await testInfo.attach('cold-and-resumed-sessions', { body: JSON.stringify({ cold: cold.evidence, restored: restored.evidence }, null, 2), contentType: 'application/json' });
    await testInfo.attach('restarted-window', { body: await fresh.screenshot(), contentType: 'image/png' });
  } finally { await browser.close(); }
});
