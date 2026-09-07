import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, bridge, chat, sendChat, root, home, sessionEvidence, baseline, native } from '../fixtures';

test('RUNTIME-002 更新源校验、邀请凭据、签名和摘要拒绝、真实内核更新与回滚', async ({ app }, testInfo) => {
  test.setTimeout(480_000);
  const fixture = path.join(root, 'update-fixture');
  const metadata = JSON.parse(readFileSync(path.join(fixture, 'metadata.json'), 'utf8'));
  const original = (await bridge<any>(app, 'getUpdateConfig')).config;
  const before = (await bridge<any>(app, 'getRuntimeInfo')).current;
  expect(before.runtimeVersion).toBe(baseline.runtimeVersion);
  const marker = `signed-update-${Date.now()}`;
  const conversation = await chat(app, `当前会话暗号 ${marker}，不要使用工具，不要写记忆，只回复 READY。`, 'READY');
  const id = conversation.evidence.session.id;
  const configFile = path.join(root, 'runtime', 'update-config.json');
  const originalConfigBytes = readFileSync(configFile);
  const readConfig = () => JSON.parse(readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
  const sourceForm = async () => {
    await route(app, '/kernel');
    if (!await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).isVisible()) {
      await app.getByRole('button', { name: '更新源设置', exact: true }).click();
    }
    await expect(app.getByLabel(/^channel/)).toBeVisible();
    // The form mounts before the asynchronous saved configuration arrives.
    // Wait for its persisted device ID so loading cannot overwrite our edit.
    await expect(app.getByLabel('deviceId（非密钥）', { exact: true })).toHaveValue(readConfig().deviceId);
  };
  const save = async () => {
    await app.getByRole('button', { name: '保存', exact: true }).click();
    await expect(app.getByText('更新源配置已保存', { exact: true })).toBeVisible();
  };
  const mode = (value: string) => {
    const file = path.join(fixture, 'mode.json');
    const current = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...current, runtime: value }));
  };
  const runtimeCard = app.locator('section,article,div').filter({ has: app.getByRole('heading', { name: 'Managed Runtime', exact: true }) })
    .filter({ has: app.getByRole('button', { name: '安装更新', exact: true }) }).last();
  let changed = false;
  const continueConversation = async (stage: string, prompt: string) => {
    await route(app, `/tasks/${id}`);
    try {
      const continued = await sendChat(app, prompt, marker);
      expect(continued.evidence.session.tool_call_count).toBe(0);
    } catch (error) {
      await testInfo.attach(stage + '-failure', { body: await app.screenshot(), contentType: 'image/png' });
      // Finish both actual lifecycle operations, retaining a failed assertion
      // for each broken continuation. No reload is allowed to conceal it.
      expect.soft(error, stage).toBeUndefined();
    }
  };
  try {
    await sourceForm();
    await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).fill('http://localhost:19445/runtime.json');
    await expect(app.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
    await expect(app.getByText('runtimeManifestUrl 必须是 https 地址', { exact: true })).toBeVisible();
    await app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true }).fill(metadata.baseUrl + '/runtime.json');
    await app.getByLabel('timeoutSeconds', { exact: true }).fill('15');
    await save();
    changed = true;
    await app.getByLabel(/^一次性邀请配置（JSON）/).fill('{invalid-json');
    await app.getByRole('button', { name: '导入邀请配置', exact: true }).click();
    await expect(app.getByRole('alert').filter({ hasText: /JSON/ }).first()).toBeVisible();
    const invitation = {
      schemaVersion: 1, channel: 'prototype', deviceId: marker, token: `local-fixture-${marker}`,
      // Import only: the product permits these official hosts. No shell check
      // is sent there; signed Runtime/UI downloads use localhost exclusively.
      endpoint: 'https://hot-update-staging.hermesagent.org.cn/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}',
    };
    await app.getByLabel(/^一次性邀请配置（JSON）/).fill(JSON.stringify(invitation));
    await app.getByRole('button', { name: '导入邀请配置', exact: true }).click();
    await expect(app.getByText('邀请配置已导入，令牌已写入系统凭据库', { exact: true })).toBeVisible();
    expect((await bridge<any>(app, 'getUpdateCredentialStatus')).configured).toBe(true);
    expect(readFileSync(configFile, 'utf8')).not.toContain(invitation.token);
    await app.reload();
    await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    await sourceForm();
    await expect(app.getByLabel(/^channel/)).toHaveValue('prototype');
    await expect(app.getByLabel('runtimeManifestUrl（可选，完整覆盖）', { exact: true })).toHaveValue(metadata.baseUrl + '/runtime.json');
    mode('runtime-bad-signature.json');
    await runtimeCard.getByRole('button', { name: '检查更新', exact: true }).click();
    // Runtime checks signatures when installing; UI packages verify them at
    // check time. Exercise the actual Runtime installation boundary.
    await expect(app.getByRole('button', { name: '安装更新', exact: true })).toBeEnabled();
    const downloadsBefore = readFileSync(path.join(fixture, 'requests.jsonl'), 'utf8').split('\n').filter(line => line.includes('"request": "/runtime.zip"')).length;
    await app.getByRole('button', { name: '安装更新', exact: true }).click();
    await expect(runtimeCard).toContainText(/signature verification failed/i);
    expect(readFileSync(path.join(fixture, 'requests.jsonl'), 'utf8').split('\n').filter(line => line.includes('"request": "/runtime.zip"')).length).toBe(downloadsBefore);
    expect((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion).toBe(before.runtimeVersion);
    await testInfo.attach('rejected-signature', { body: await runtimeCard.ariaSnapshot(), contentType: 'text/plain' });
    mode('runtime-bad-hash.json');
    await runtimeCard.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(app.getByRole('button', { name: '安装更新', exact: true })).toBeEnabled();
    await app.getByRole('button', { name: '安装更新', exact: true }).click();
    await expect(runtimeCard).toContainText(/SHA-?256.*mismatch/i, { timeout: 90_000 });
    expect((await bridge<any>(app, 'getRuntimeInfo')).current.runtimeVersion).toBe(before.runtimeVersion);
    await testInfo.attach('rejected-archive-hash', { body: await runtimeCard.ariaSnapshot(), contentType: 'text/plain' });
    mode('runtime-good.json');
    await runtimeCard.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(app.getByRole('button', { name: '安装更新', exact: true })).toBeEnabled();
    await app.getByRole('button', { name: '安装更新', exact: true }).click();
    await expect.poll(async () => (await bridge<any>(app, 'getRuntimeInfo')).current?.runtimeVersion, { timeout: 120_000 }).toBe('0.21.0-cn.4');
    // current.json is committed before the new Core finishes booting. Wait
    // for the UI's completed result, including its token-refresh settlement.
    await expect(app.getByText('已切换到 runtime 0.21.0-cn.4', { exact: true })).toBeVisible({ timeout: 120_000 });
    await expect.poll(async () => (await bridge<any>(app, 'getRuntimeInfo')).process?.pid).toBeGreaterThan(0);
    await expect(app.getByRole('button', { name: '回滚 Runtime', exact: true })).toBeEnabled({ timeout: 120_000 });
    const updated = (await bridge<any>(app, 'getRuntimeInfo')).current;
    expect(updated.source).toBe('update');
    expect(updated.sourceCommit).toBe(baseline.coreCommit);
    expect(updated.artifactSha256).toBe(metadata.runtimeSha256);
    await continueConversation('after-update', '只凭本会话上下文回复暗号，不要调用工具或读取记忆。');
    await route(app, '/kernel');
    await app.getByRole('button', { name: '回滚 Runtime', exact: true }).click();
    await expect.poll(async () => (await bridge<any>(app, 'getRuntimeInfo')).current?.runtimeVersion, { timeout: 120_000 }).toBe(before.runtimeVersion);
    await expect(app.getByText(`已回滚到 runtime ${before.runtimeVersion}`, { exact: true })).toBeVisible();
    await continueConversation('after-rollback', '回滚后仍然只凭本会话上下文回复暗号，不使用任何工具。');
    await testInfo.attach('real-update-and-rollback', { body: JSON.stringify({ before, updated, final: (await bridge<any>(app, 'getRuntimeInfo')).current, session: sessionEvidence(id, home) }, null, 2), contentType: 'application/json' });
  } finally {
    if (!app.isClosed()) {
      await testInfo.attach('runtime-before-cleanup', { body: await app.screenshot(), contentType: 'image/png' });
      if ((await bridge<any>(app, 'getRuntimeInfo')).current?.runtimeVersion === '0.21.0-cn.4') {
        await route(app, '/kernel');
        await app.getByRole('button', { name: '回滚 Runtime', exact: true }).click();
        await expect(app.getByText(`已回滚到 runtime ${before.runtimeVersion}`, { exact: true })).toBeVisible({ timeout: 120_000 });
      }
    }
    if (changed && !app.isClosed()) {
      await sourceForm();
      await app.getByLabel(/^channel/).selectOption(original.channel);
      for (const [label, field] of [['shellUpdaterEndpoint（Tauri 动态检查端点）', 'shellUpdaterEndpoint'], ['deviceId（非密钥）', 'deviceId'], ['runtimeManifestUrl（可选，完整覆盖）', 'runtimeManifestUrl'], ['timeoutSeconds', 'timeoutSeconds']]) {
        await app.getByLabel(label, { exact: true }).fill(String(original[field]));
      }
      await save();
      expect(readConfig()).toEqual(original);
    }
    await native({ action: 'deleteUpdateFixtureCredential', deviceId: marker });
    if (changed && app.isClosed()) writeFileSync(configFile, originalConfigBytes);
    mode('runtime-good.json');
    if (existsSync(path.join(fixture, 'requests.jsonl'))) await testInfo.attach('local-update-server-requests', { path: path.join(fixture, 'requests.jsonl'), contentType: 'application/x-ndjson' });
    if (!app.isClosed()) {
      await app.reload();
      await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady);
    }
  }
});
