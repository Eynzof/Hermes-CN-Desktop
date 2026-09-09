import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, route, chat, sendChat, bridge, root, home, sessionEvidence } from '../fixtures';

for (const [id, title, operation] of [
  ['RUNTIME-001', '内核停启、离线状态和数据保留', 'stop'],
  ['RUNTIME-005', 'Gateway 重启和真实原会话恢复', 'restart'],
  ['RUNTIME-006', '内核重装和真实原会话恢复', 'reinstall'],
  ['RUNTIME-007', '取消卸载、卸载再安装和真实原会话恢复', 'uninstall'],
]) test(`${id} ${title}`, async ({ app }, testInfo) => {
  test.setTimeout(480_000);
  const marker = `runtime-preserved-${Date.now()}`;
  const file = path.join(root, 'workspace', marker + '.txt');
  writeFileSync(file, marker);
  const initial = await chat(app, `当前会话暗号是 ${marker}。不要调用任何工具，不要写入记忆，只回复 READY。`, 'READY');
  expect(initial.evidence.session.tool_call_count).toBe(0);
  const id = initial.evidence.session.id;
  const files = ['config.yaml', '.env', 'SOUL.md'].map(name => path.join(home, name));
  const hashes = () => Object.fromEntries(files.filter(existsSync).map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
  const originalHashes = hashes();
  const records: any[] = [];
  const control = () => bridge<any>(app, 'getDesktopControlState');
  const checkpoint = async (stage: string) => {
    expect(readFileSync(file, 'utf8')).toBe(marker);
    expect(hashes()).toEqual(originalHashes);
    expect(sessionEvidence(id).messages.some((m: any) => m.role === 'assistant' && m.content.trim() === 'READY')).toBe(true);
    records.push({ stage, control: await control(), hashes: hashes() });
    await testInfo.attach(stage, { body: await app.screenshot(), contentType: 'image/png' });
  };
  const ready = async () => {
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady, undefined, { timeout: 120_000 });
    await expect(app.getByRole('button', { name: '停止内核', exact: true })).toBeEnabled({ timeout: 120_000 });
  };
  try {
  await route(app, '/kernel');
  if (operation === 'stop') {
    const initialPid = (await bridge<any>(app, 'getRuntimeInfo')).process.pid;
    const stoppedReload = app.waitForEvent('load', { timeout: 60_000 });
    await app.getByRole('button', { name: '停止内核', exact: true }).click();
    await stoppedReload;
    await expect(app.getByText('离线控制台', { exact: true })).toBeVisible();
    expect(existsSync(path.join(root, 'runtime', 'current.json'))).toBe(true);
    await checkpoint('stopped-data-preserved');
    await app.getByRole('link', { name: /^软件更新：/ }).click();
    await expect(app).toHaveURL(/#\/updates$/);
    await expect(app.getByRole('heading', { name: '软件更新', exact: true })).toBeVisible();
    await expect(app.getByText('Hermes Desktop v0.9.0', { exact: true })).toBeVisible();
    await expect(app.getByLabel('runtimeManifestUrl（可选，完整覆盖）')).toBeHidden();
    await testInfo.attach('updates-remain-available-offline', { body: await app.screenshot(), contentType: 'image/png' });
    await app.getByText('高级更新选项', { exact: true }).click();
    await expect(app.getByRole('button', { name: '检查内核更新', exact: true })).toBeVisible();
    await route(app, '/kernel');
    await app.reload();
    await expect(app.getByRole('button', { name: '启动内核', exact: true })).toBeEnabled();
    expect((await control()).running).toBe(false);
    const startedReload = app.waitForEvent('load', { timeout: 120_000 });
    await app.getByRole('button', { name: '启动内核', exact: true }).click();
    await startedReload;
    await ready();
    expect((await bridge<any>(app, 'getRuntimeInfo')).process.pid).not.toBe(initialPid);
    await checkpoint('started-data-preserved');
  } else if (operation === 'restart') {
    await app.getByRole('button', { name: '重启 Gateway', exact: true }).click();
    // Gateway is a separate action service, not the Dashboard PID.
    await expect(app.getByRole('button', { name: '网关已重启', exact: true })).toBeVisible({ timeout: 90_000 });
    await checkpoint('restarted-data-preserved');
  } else if (operation === 'reinstall') {
    const reloaded = app.waitForEvent('load', { timeout: 120_000 });
    await app.getByRole('button', { name: '重装内核', exact: true }).click();
    await reloaded;
    await ready();
    await checkpoint('reinstalled-data-preserved');
  } else if (operation === 'uninstall') {
    await app.getByRole('button', { name: '卸载内核', exact: true }).click();
    await app.getByRole('dialog', { name: '卸载内置内核', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    expect((await control()).running).toBe(true);
    await app.getByRole('button', { name: '卸载内核', exact: true }).click();
    const uninstalledReload = app.waitForEvent('load', { timeout: 90_000 });
    await app.getByRole('dialog', { name: '卸载内置内核', exact: true }).getByRole('button', { name: '卸载', exact: true }).click();
    await uninstalledReload;
    await expect(app.getByText('内置内核已卸载', { exact: true })).toBeVisible({ timeout: 90_000 });
    expect((await control()).installed).toBe(false);
    expect(existsSync(path.join(root, 'runtime', 'current.json'))).toBe(false);
    expect(existsSync(path.join(root, 'runtime', 'versions'))).toBe(false);
    await checkpoint('uninstalled-data-preserved');
    await app.getByRole('button', { name: '重新安装内核', exact: true }).click();
    await expect(app.getByRole('button', { name: '启动内核', exact: true })).toBeEnabled({ timeout: 120_000 });
    expect((await control()).running).toBe(false);
    const installedReload = app.waitForEvent('load', { timeout: 120_000 });
    await app.getByRole('button', { name: '启动内核', exact: true }).click();
    await installedReload;
    await ready();
    await checkpoint('installed-again-data-preserved');
  }
  await route(app, '/history');
  const history = app.getByRole('main');
  await history.getByRole('searchbox').fill(id);
  await expect(history.locator('[data-status]')).toHaveCount(1);
  await history.locator('[data-status]').click();
  await expect(app).toHaveURL(new RegExp(`/tasks/${id}$`));
  await expect(app.getByRole('log')).toContainText('READY');
  await testInfo.attach('history-opened-original-session', { body: await app.screenshot(), contentType: 'image/png' });
  const resumed = await sendChat(app, '只凭当前会话上下文回复暗号，不要调用任何工具，也不要读取记忆或搜索历史。', marker);
  expect(resumed.evidence.session.id).toBe(id);
  expect(resumed.evidence.session.tool_call_count).toBe(0);
  await testInfo.attach('lifecycle-and-file-integrity', { body: JSON.stringify(records, null, 2), contentType: 'application/json' });
  await testInfo.attach('real-resumed-session', { body: JSON.stringify(resumed.evidence, null, 2), contentType: 'application/json' });
  } finally {
    // A Desktop exit blocks subsequent UI steps, but disk preservation is
    // independently observable. Keep it as evidence, never a lifecycle pass.
    const disk: Record<string, unknown> = {
      operation, pageClosed: app.isClosed(), completedCheckpoints: records,
      initialHashes: originalHashes, finalHashes: hashes(),
      markerPreserved: existsSync(file) && readFileSync(file, 'utf8') === marker,
      currentRecordExists: existsSync(path.join(root, 'runtime', 'current.json')),
      versionsDirectoryExists: existsSync(path.join(root, 'runtime', 'versions')),
    };
    try {
      const evidence = sessionEvidence(id);
      disk.sessionId = id;
      disk.readyReplyPreserved = evidence.messages.some((m: any) => m.role === 'assistant' && m.content.trim() === 'READY');
    } catch (error) {
      disk.sessionReadError = String(error);
    }
    await testInfo.attach('lifecycle-final-disk-evidence', { body: JSON.stringify(disk, null, 2), contentType: 'application/json' });
  }
});
