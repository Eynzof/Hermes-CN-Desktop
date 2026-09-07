import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, chat, sendChat, route, bridge, root } from '../fixtures';

test('SHELL-005 真实内核进程意外结束、失联反馈、启动修复与原会话恢复', async ({ app }, testInfo) => {
  const marker = `backend-loss-${Date.now()}`;
  const file = path.join(root, 'workspace', marker + '.txt');
  writeFileSync(file, marker);
  const initial = await chat(app, `本会话暗号是 ${marker}。禁止调用任何工具，只回复 READY。`, 'READY');
  const before = await bridge<any>(app, 'getRuntimeInfo');
  const desktop = JSON.parse(readFileSync(path.join(root, 'reports', 'desktop-process.json'), 'utf8').replace(/^\uFEFF/, ''));
  expect(before.process.pid).toBeGreaterThan(0);
  expect(before.process.pid).not.toBe(desktop.pid);
  const process = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(before.process.pid)}' | Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }));
  expect(process.ExecutablePath.toLowerCase()).toBe(before.current.executablePath.toLowerCase());
  // Deliberate fault injection is limited to the verified test Core process.
  const killed = execFileSync('taskkill.exe', ['/PID', String(process.ProcessId), '/F'], { encoding: 'utf8', windowsHide: true });
  await testInfo.attach('verified-core-fault-injection', { body: JSON.stringify({ desktop: desktop.pid, core: process, killed }, null, 2), contentType: 'application/json' });
  await expect.poll(async () => (await bridge<any>(app, 'getDesktopControlState')).running, { timeout: 30_000 }).toBe(false);
  await route(app, '/kernel');
  await expect(app.getByRole('button', { name: '启动内核', exact: true })).toBeEnabled({ timeout: 30_000 });
  await testInfo.attach('backend-lost-recovery-control', { body: await app.screenshot(), contentType: 'image/png' });
  const loaded = app.waitForEvent('load', { timeout: 120_000 });
  await app.getByRole('button', { name: '启动内核', exact: true }).click();
  await loaded;
  await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady, undefined, { timeout: 120_000 });
  const after = await bridge<any>(app, 'getRuntimeInfo');
  expect(after.process.pid).not.toBe(process.ProcessId);
  expect(JSON.parse(readFileSync(path.join(root, 'reports', 'desktop-process.json'), 'utf8').replace(/^\uFEFF/, '')).pid).toBe(desktop.pid);
  expect(readFileSync(file, 'utf8')).toBe(marker);
  await route(app, `/tasks/${initial.evidence.session.id}`);
  const recovered = await sendChat(app, '只从这个会话的上下文回答暗号，不要使用任何工具。', marker);
  expect(recovered.evidence.session.id).toBe(initial.evidence.session.id);
  expect(recovered.evidence.session.tool_call_count).toBe(0);
  await testInfo.attach('recovered-real-session', { body: JSON.stringify({ before: before.process, after: after.process, session: recovered.evidence }, null, 2), contentType: 'application/json' });
});
