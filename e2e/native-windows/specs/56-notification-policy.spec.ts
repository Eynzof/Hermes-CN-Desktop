import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, native, chat, root, python, api, sessionEvidence } from '../fixtures';

test('SET-006 前后台完成提醒、真实审批提醒以及扬声器提示音开关', async ({ app }, testInfo) => {
  test.setTimeout(240_000);
  const marker = `notify-policy-${Date.now()}`;
  const labels = ['系统通知', '提示音', '任务完成时通知', '需要权限确认时通知', '仅窗口在后台时通知'];
  const row = (label: string) => app.getByText(label, { exact: true }).locator('..').locator('..');
  const set = (label: string, value: string) => row(label).getByRole('button', { name: value, exact: true }).click();
  const receipts = () => JSON.parse(execFileSync(python, [path.join(root, 'native-windows', 'scripts', 'notification-evidence.py')], { encoding: 'utf8' }));
  const latest = () => Math.max(0, ...receipts().map((item: any) => item.ArrivalTime));
  const window = (await native({ action: 'windows' })).windows.find((w: any) => w.class === 'Tauri Window');
  const foreground = async () => {
    await native({ action: 'windowState', window: window.name, state: 'normal' });
    await native({ action: 'activate', window: window.name });
    if ((await native({ action: 'foreground' })).window?.handle !== window.handle) {
      await native({ action: 'focusTitleBar', window: window.name });
    }
    await expect.poll(async () => (await native({ action: 'foreground' })).window?.handle).toBe(window.handle);
  };
  const approvalMode = (await api(app, '/api/config')).approvals?.mode || 'smart';
  await route(app, '/notifications');
  const previous = await Promise.all(labels.map(label => row(label).locator('button[data-active="true"]').innerText()));
  const observed: any[] = [];
  await app.evaluate(() => {
    const w = window as any, bridge = w.hermesDesktop, original = bridge.desktopNotify;
    w.__notificationAcceptance = { original, events: [] };
    bridge.desktopNotify = async function(input: any) {
      const event: any = { input, startedAt: Date.now() };
      w.__notificationAcceptance.events.push(event);
      try { const result = await original.call(bridge, input); event.result = result; return result; }
      catch(error) { event.error = String(error); throw error; }
      finally { event.finishedAt = Date.now(); }
    };
  });

  const record = async (phase: string, trigger?: () => Promise<unknown>) => {
    const target = path.join(testInfo.outputDir, phase);
    const child = spawn(python, [path.join(root, 'native-windows', 'scripts', 'audio-evidence.py'), '--output', target, '--seconds', '10'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    child.stdout.on('data', data => log += data);
    child.stderr.on('data', data => log += data);
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve));
    try {
      await expect.poll(() => {
        if (child.exitCode !== null) throw new Error(`Actual WASAPI capture exited: ${log}`);
        return existsSync(target + '.ready.json');
      }).toBe(true);
      if (trigger) await trigger();
      expect(await exited).toBe(0);
      const evidence = JSON.parse(readFileSync(target + '.json', 'utf8'));
      await testInfo.attach(`${phase}-audio`, { path: target + '.wav', contentType: 'audio/wav' });
      await testInfo.attach(`${phase}-levels`, { path: target + '.json', contentType: 'application/json' });
      return evidence;
    } finally { if (child.exitCode === null) child.kill(); }
  };
  try {
    await set('系统通知', '开启');
    await set('提示音', '开启');
    await native({ action: 'windowState', window: window.name, state: 'minimized' });
    const audible = await record('notification-sound-on', () => app.getByRole('button', { name: '测试', exact: true }).click());
    expect(audible.peak, 'An isolated real notification must reach the speaker before testing later notification policies').toBeGreaterThan(0.01);
    expect(audible.maxRms).toBeGreaterThan(0.001);
    await foreground();
    await set('提示音', '关闭');
    const quiet = await record('speaker-quiet-baseline');
    expect(quiet.peak).toBeLessThan(0.01);
    const silent = await record('notification-sound-off', () => app.getByRole('button', { name: '测试', exact: true }).click());
    expect(silent.peak, 'Turning prompt sound off must keep actual output silent').toBeLessThan(0.01);
    observed.push({ phase: 'speaker-loopback', quietPeak: quiet.peak, soundOffPeak: silent.peak, soundOnPeak: audible.peak, soundOnFrames: audible.totalFrames, device: audible.device,
      toasts: receipts().filter((item: any) => item.Payload.includes('Hermes 通知测试')).slice(0, 2) });
    const calibration = await record('speaker-positive-calibration', () => new Promise<void>((resolve, reject) => {
      const player = spawn(python, ['-c', 'import winsound; winsound.PlaySound("C:/Windows/Media/Windows Notify System Generic.wav", winsound.SND_FILENAME)'], { windowsHide: true });
      player.once('error', reject);
      player.once('exit', code => code === 0 ? resolve() : reject(new Error(`System WAV player exited ${code}`)));
    }));
    expect(calibration.peak, 'The same Node child-process recorder must detect a real Windows WAV positive control').toBeGreaterThan(0.01);
    expect(calibration.totalFrames).toBeGreaterThan(0);
    observed.push({ phase: 'positive-calibration', peak: calibration.peak, device: calibration.device });
    for (const label of labels) await set(label, label === '提示音' ? '关闭' : '开启');
    await foreground();
    let since = latest();
    await chat(app, `FG-${marker}：不要调用工具，只回复 FG-DONE。`, 'FG-DONE');
    // The real turn has completed. Allow asynchronous native delivery to settle.
    await app.waitForTimeout(1500);
    const foregroundReceipts = receipts().filter((item: any) => item.ArrivalTime > since && item.Payload.includes(marker));
    expect(foregroundReceipts).toHaveLength(0);
    observed.push({ phase: 'foreground-suppressed', receipts: foregroundReceipts });
    since = latest();
    const backgroundTurn = chat(app, `BG-${marker}：先调用 terminal 执行 powershell.exe -NoProfile -Command "Start-Sleep -Seconds 4"，然后只回复 BG-DONE。`, 'BG-DONE');
    await expect(app.getByRole('button', { name: '中止响应', exact: true })).toBeVisible();
    await native({ action: 'windowState', window: window.name, state: 'minimized' });
    await backgroundTurn;
    await expect.poll(() => receipts().filter((item: any) => item.ArrivalTime > since && item.Payload.includes(marker)).length).toBe(1);
    observed.push({ phase: 'background-complete', receipts: receipts().filter((item: any) => item.ArrivalTime > since) });
    await foreground();
    await route(app, '/common');
    await app.getByRole('radio', { name: /^默认手动审批/ }).click();
    const folder = path.join(root, 'workspace', marker);
    mkdirSync(folder); writeFileSync(path.join(folder, 'keep.txt'), marker);
    const command = `powershell.exe -NoProfile -Command "Remove-Item -LiteralPath '${folder.replaceAll('\\', '/')}' -Recurse -Force"`;
    await route(app, '/');
    await app.getByRole('textbox', { name: '输入消息', exact: true }).fill(`只调用 terminal 执行 ${command}。仅删除这个已授权的隔离测试目录；如果拒绝审批就停止，不要换命令重试。`);
    since = latest();
    await app.getByRole('button', { name: '发送消息', exact: true }).click();
    await native({ action: 'windowState', window: window.name, state: 'minimized' });
    await expect(app.getByRole('button', { name: '拒绝', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => receipts().filter((item: any) => item.ArrivalTime > since && item.Payload.includes('需要权限确认')).length).toBe(1);
    observed.push({ phase: 'background-approval', receipts: receipts().filter((item: any) => item.ArrivalTime > since) });
    await foreground();
    await app.getByRole('button', { name: '拒绝', exact: true }).click();
    await expect(app.getByRole('button', { name: '中止响应', exact: true })).toHaveCount(0, { timeout: 60_000 });
    expect(readFileSync(path.join(folder, 'keep.txt'), 'utf8')).toBe(marker);
    const id = decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]);
    await testInfo.attach('real-approval-session', { body: JSON.stringify(sessionEvidence(id), null, 2), contentType: 'application/json' });

  } finally {
    await testInfo.attach('native-notification-calls', { body: JSON.stringify(await app.evaluate(() => { const w = window as any, data = w.__notificationAcceptance; w.hermesDesktop.desktopNotify = data.original; delete w.__notificationAcceptance; return data.events; }), null, 2), contentType: 'application/json' });
    await testInfo.attach('actual-notification-policy', { body: JSON.stringify(observed, null, 2), contentType: 'application/json' });
    await foreground();
    const reject = app.getByRole('button', { name: '拒绝', exact: true });
    if (await reject.isVisible()) await reject.click();
    const stop = app.getByRole('button', { name: '中止响应', exact: true });
    if (await stop.isVisible()) { await stop.click(); await expect(stop).toBeHidden({ timeout: 30_000 }); }
    await route(app, '/common');
    await app.getByRole('radio', { name: approvalMode === 'manual' ? /^默认手动审批/ : /^Smart 智能审批/ }).click();
    await route(app, '/notifications');
    for (let i = 0; i < labels.length; i++) await set(labels[i], previous[i]);
  }
});
