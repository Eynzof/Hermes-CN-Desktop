import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, bridge, chat, sendChat, root, baseline, sessionEvidence } from '../fixtures';

test('RUNTIME-002 高级渠道与更新源、签名和摘要校验、内核分步更新及回退', async ({ app }, testInfo) => {
  test.setTimeout(480_000);
  const fixture = path.join(root, 'update-fixture');
  const metadata = JSON.parse(readFileSync(path.join(fixture, 'metadata.json'), 'utf8'));
  const original = (await bridge<any>(app, 'getUpdateConfig')).config;
  const before = await bridge<any>(app, 'getRuntimeInfo');
  const modeFile = path.join(fixture, 'mode.json');
  const mode = (runtime: string) => writeFileSync(modeFile, JSON.stringify({ ...JSON.parse(readFileSync(modeFile, 'utf8')), runtime, delayMs: 0 }));
  const state = () => bridge<any>(app, 'softwareUpdateSnapshot');
  const form = async () => {
    await route(app, '/updates?advanced=1');
    if (!await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).isVisible()) await app.getByRole('button', { name: '更新源设置', exact: true }).click();
    await expect(app.getByLabel('deviceId（非密钥）', { exact: true })).toHaveValue((await bridge<any>(app, 'getUpdateConfig')).config.deviceId);
  };
  const settled = async () => expect.poll(async () => ['checking', 'downloading', 'applying'].includes((await state()).phase), { timeout: 120_000 }).toBe(false);
  const check = async () => {
    await route(app, '/updates?advanced=1');
    await app.getByRole('button', { name: '检查内核更新', exact: true }).click();
    await settled();
  };
  const rollback = async () => {
    await route(app, '/updates?advanced=1');
    await app.getByRole('button', { name: '恢复上一版内核', exact: true }).click();
    await app.getByRole('dialog', { name: '恢复上一版内核', exact: true }).getByRole('button', { name: '恢复上一版', exact: true }).click();
    await expect.poll(async () => (await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion, { timeout: 120_000 }).toBe(baseline.runtimeVersion);
    await expect.poll(async () => (await state()).phase, { timeout: 120_000 }).toBe('completed');
    expect((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion).toBe(baseline.runtimeVersion);
  };
  const marker = `update-history-${Date.now()}`;
  const existingNotice = app.getByRole('dialog', { name: /^(Hermes 有更新可用|更新已准备好)$/ });
  if (await existingNotice.isVisible()) await existingNotice.getByRole('button', { name: '稍后提醒', exact: true }).click();
  const conversation = await chat(app, `本会话暗号是 ${marker}。不使用工具，不写记忆，只回复 READY。`, 'READY');
  try {
    await form();
    await expect(app.getByText(/nightly 构建沿用原有分发渠道/)).toBeVisible();
    await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).fill('http://localhost:19445/runtime.json');
    await expect(app.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).fill(metadata.baseUrl + '/runtime.json');
    await app.getByRole('combobox', { name: /^更新渠道（channel）/ }).selectOption('prototype');
    await app.getByLabel('timeoutSeconds', { exact: true }).fill('10');
    await app.getByRole('button', { name: '保存并测试连接', exact: true }).click();
    await settled();
    expect((await state()).channel).toBe('prototype');
    await expect(app.getByRole('button', { name: '使用自定义更新源', exact: true })).toBeVisible();
    mode('runtime-bad-signature.json');
    await check();
    expect((await state()).error.code).toBe('verification_failed');
    expect((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion).toBe(before.current.runtimeVersion);
    mode('runtime-bad-hash.json');
    await check();
    await app.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect.poll(async () => (await state()).error?.code, { timeout: 120_000 }).toBe('verification_failed');
    expect((await bridge<any>(app, 'getRuntimeInfo')).process.pid).toBe(before.process.pid);
    mode('runtime-good.json');
    await check();
    await app.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect.poll(async () => (await state()).phase, { timeout: 120_000 }).toBe('ready');
    expect((await bridge<any>(app, 'getRuntimeInfo')).process.pid).toBe(before.process.pid);
    // Saving a new source/channel invalidates the prepared plan. Returning to
    // stable never installs an older kernel without an explicit rollback.
    await form();
    await app.getByRole('combobox', { name: /^更新渠道（channel）/ }).selectOption('stable');
    await app.getByRole('button', { name: '保存', exact: true }).click();
    await settled();
    expect((await state()).phase).not.toBe('ready');
    expect((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion).toBe(baseline.runtimeVersion);
    await check();
    await app.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect.poll(async () => (await state()).phase, { timeout: 120_000 }).toBe('ready');
    await app.getByRole('button', { name: '重启内核并应用', exact: true }).click();
    await expect.poll(async () => (await state()).phase, { timeout: 120_000 }).toBe('completed');
    const updated = await bridge<any>(app, 'getRuntimeInfo');
    expect(updated.current.runtimeVersion).toBe(metadata.runtimeVersion);
    expect(updated.process.pid).not.toBe(before.process.pid);
    expect((await state()).currentVersion).toBe(baseline.desktopVersion);
    await route(app, `/tasks/${conversation.evidence.session.id}`);
    await sendChat(app, '只从当前会话上下文回复暗号，不调用工具。', marker);
    await rollback();
    await route(app, `/tasks/${conversation.evidence.session.id}`);
    await sendChat(app, '回退后仍然只从本会话上下文回复暗号，不调用工具。', marker);
    await testInfo.attach('actual-runtime-transitions', { body: JSON.stringify({ before, updated, restored: await bridge(app, 'getRuntimeInfo'), session: sessionEvidence(conversation.evidence.session.id) }, null, 2), contentType: 'application/json' });
  } finally {
    mode('runtime-good.json');
    if ((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion === metadata.runtimeVersion) await rollback();
    await form();
    await app.getByRole('combobox', { name: /^更新渠道（channel）/ }).selectOption(original.channel);
    await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).fill(original.runtimeManifestUrl);
    await app.getByLabel('timeoutSeconds', { exact: true }).fill(String(original.timeoutSeconds));
    await app.getByRole('button', { name: '保存', exact: true }).click();
    await settled();
  }
});
