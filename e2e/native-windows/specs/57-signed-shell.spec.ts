import { chromium, type Page, type Browser } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { test, expect, route, bridge, chat, sendChat, quitFromTray, native, root, home, baseline, sessionEvidence } from '../fixtures';

test('RUNTIME-004 真实签名整包拒绝错误候选、取消和缓存、复核授权、安装自动重启与数据保留', async ({ app }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = path.join(root, 'shell-update-fixture');
  const processFile = path.join(root, 'reports', 'desktop-process.json');
  const configFile = path.join(root, 'runtime', 'update-config.json');
  const pendingFile = path.join(root, 'runtime', 'desktop-updater-cache', 'pending.json');
  const originalConfig = readFileSync(configFile);
  const originalProcess = JSON.parse(readFileSync(processFile, 'utf8').replace(/^\uFEFF/, ''));
  const marker = `signed-update-${Date.now()}`;
  const recovery = path.join(root, 'secrets', 'shell-cases', marker);
  mkdirSync(recovery, { recursive: true });
  writeFileSync(path.join(recovery, 'update-config.json'), originalConfig);
  writeFileSync(path.join(recovery, 'desktop-process.json'), JSON.stringify(originalProcess));
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  const ps = (script: string, timeout = 120_000) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new();${script}`, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout });
  const script = (name: string, args = '') => ps(`& '${path.join(root, 'native-windows', 'scripts', name)}' -Root '${root}' ${args}`);
  const browsers: Browser[] = [];
  let page: Page = app;
  let fixtureStarted = false;
  let desktopRestarted = false;
  let installRequested = false;
  const helper = path.join(root, 'runtime', 'desktop-updater-cache', 'updater-helper.log');
  let helperOffset = 0;
  let completedHelper = '';
  const helperOutput = () => {
    const current = existsSync(helper) ? readFileSync(helper, 'utf8').slice(helperOffset) : '';
    if (current.includes('helper-complete')) completedHelper = current;
    // Successful startup clears its consumed update cache, including this log.
    return current || completedHelper;
  };
  const connect = async () => {
    await expect.poll(async () => { try { return (await fetch('http://127.0.0.1:19229/json/version', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, { timeout: 120_000 }).toBe(true);
    const browser = await chromium.connectOverCDP('http://127.0.0.1:19229');
    browsers.push(browser);
    let candidate: Page | undefined;
    await expect.poll(() => {
      candidate = browser.contexts().flatMap(context => context.pages()).find(p => p.url().includes('hermesui.localhost'));
      return Boolean(candidate);
    }, { timeout: 120_000, message: 'The new WebView must navigate beyond its initial blank target' }).toBe(true);
    page = candidate!;
    page.setDefaultTimeout(20_000);
    await page.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady, undefined, { timeout: 120_000 });
    if (hash(originalProcess.appExe) === baseline.installedDesktopSha256 && existsSync(pendingFile)) {
      const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
      const metadata = JSON.parse(readFileSync(path.join(fixture, 'metadata.json'), 'utf8'));
      expect(pending.sha256).toBe(metadata.candidateInstallerSha256);
      expect(pending.version).toBe(metadata.version);
      const notice = page.getByRole('dialog', { name: 'Hermes Desktop 更新包已准备好', exact: true });
      await expect(notice).toBeVisible();
      await testInfo.attach('owned-pending-update-startup-notice', { body: await notice.ariaSnapshot(), contentType: 'text/plain' });
      await notice.getByRole('button', { name: '稍后', exact: true }).click();
      await expect(notice).toBeHidden();
    } else if (hash(originalProcess.appExe) !== baseline.installedDesktopSha256) {
      // The candidate consumes its pending record asynchronously on startup;
      // it must not offer an update to the version it is already running.
      await expect.poll(() => existsSync(pendingFile)).toBe(false);
      await expect(page.getByRole('dialog', { name: 'Hermes Desktop 更新包已准备好', exact: true })).toBeHidden();
    }
  };
  const identify = () => {
    const processes = JSON.parse(ps(`@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -eq '${originalProcess.appExe}'} | Select-Object ProcessId,ExecutablePath) | ConvertTo-Json -Compress`));
    const items = Array.isArray(processes) ? processes : [processes];
    expect(items).toHaveLength(1);
    const record = { ...originalProcess, pid: items[0].ProcessId, shellUpdateFixture: true };
    writeFileSync(processFile, JSON.stringify(record));
    return record;
  };
  const mode = (manifest: string, authorized = true) => writeFileSync(path.join(fixture, 'mode.json'), JSON.stringify({ manifest, authorized, deviceId: marker }));
  const requests = () => existsSync(path.join(fixture, 'requests.jsonl')) ? readFileSync(path.join(fixture, 'requests.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const downloadCount = () => requests().filter(item => item.host === 'dl-desktop.hermesagent.org.cn' && item.method === 'GET').length;
  const check = () => page.getByRole('button', { name: '一键更新', exact: true }).locator('..').getByRole('button', { name: '检查更新', exact: true }).click();
  const begin = async () => {
    await page.getByRole('button', { name: '一键更新', exact: true }).click();
    await page.getByRole('dialog', { name: '更新 Hermes Desktop', exact: true }).getByRole('button', { name: '下载并验证', exact: true }).click();
  };
  try {
    script('start-shell-update-fixture.ps1');
    fixtureStarted = true;
    const metadata = JSON.parse(readFileSync(path.join(fixture, 'metadata.json'), 'utf8'));
    await quitFromTray();
    script('start.ps1', '-ShellUpdateFixture');
    desktopRestarted = true;
    await connect();
    const before = await chat(page, `整包更新的本会话暗号是 ${marker}，不要调用工具，不写记忆，只回复 READY。`, 'READY');
    const id = before.evidence.session.id;
    const userConfigSha = hash(path.join(home, 'config.yaml'));
    const modelKeySha = hash(path.join(home, '.env'));
    const beforeRecord = identify();
    const coreBefore = (await bridge<any>(page, 'getRuntimeInfo')).process.pid;
    await route(page, '/kernel');
    await page.getByRole('button', { name: '更新源设置', exact: true }).click();
    await expect(page.getByLabel('deviceId（非密钥）', { exact: true })).toHaveValue(JSON.parse(originalConfig.toString('utf8').replace(/^\uFEFF/, '')).deviceId);
    const invitation = { schemaVersion: 1, channel: 'prototype', deviceId: marker, token: `local-fixture-${marker}`, endpoint: 'https://hot-update-staging.hermesagent.org.cn/v1/check/{{channel}}/{{target}}/{{arch}}/{{current_version}}' };
    await page.getByLabel(/^一次性邀请配置（JSON）/).fill(JSON.stringify(invitation));
    await page.getByRole('button', { name: '导入邀请配置', exact: true }).click();
    await expect(page.getByText('邀请配置已导入，令牌已写入系统凭据库', { exact: true })).toBeVisible();
    mode('good.json');
    await check();
    await expect(page.getByText(/发现新版本.*0\.9\.1-prototype\.local\.1/)).toBeVisible();
    const count = downloadCount();
    await page.getByRole('button', { name: '一键更新', exact: true }).click();
    await page.getByRole('dialog', { name: '更新 Hermes Desktop', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    expect(downloadCount()).toBe(count);
    expect((await bridge<any>(page, 'getRuntimeInfo')).process.pid).toBe(coreBefore);
    for (const [candidate, expected] of [['bad-signature.json', /签名验证失败.*禁止回退/], ['bad-hash.json', /SHA-256 不匹配/]] as const) {
      mode(candidate);
      await begin();
      await expect(page.getByText(expected)).toBeVisible({ timeout: 90_000 });
      expect(hash(originalProcess.appExe)).toBe(baseline.installedDesktopSha256);
      expect((await bridge<any>(page, 'getRuntimeInfo')).process.pid).toBe(coreBefore);
      await testInfo.attach(candidate, { body: await page.screenshot(), contentType: 'image/png' });
    }
    mode('good.json');
    await begin();
    await expect(page.getByRole('dialog', { name: '更新包已准备好', exact: true })).toBeVisible({ timeout: 90_000 });
    await page.getByRole('button', { name: '稍后', exact: true }).click();
    await expect(page.getByText(/更新包已缓存/)).toBeVisible();
    expect(hash(path.join(root, 'runtime', 'desktop-updater-cache', 'pending-update.exe'))).toBe(metadata.candidateInstallerSha256);
    expect((await bridge<any>(page, 'getRuntimeInfo')).process.pid).toBe(coreBefore);
    await route(page, `/tasks/${id}`);
    await sendChat(page, '请只从本会话上下文回复暗号，不调用工具。', marker);
    await route(page, '/kernel');
    await check();
    await begin();
    await expect(page.getByRole('button', { name: '立即重启安装', exact: true })).toBeVisible({ timeout: 90_000 });
    mode('good.json', false);
    await page.getByRole('button', { name: '立即重启安装', exact: true }).click();
    // Tauri maps non-success HTTP responses to this generic release error.
    // Keep the actual 403 in server evidence instead of assuming UI wording.
    await expect(page.getByText(/检查更新失败.*Could not fetch a valid release JSON/)).toBeVisible();
    expect(requests().filter(item => item.path.startsWith('/v1/check/')).at(-1)?.status).toBe(403);
    expect(identify().pid).toBe(beforeRecord.pid);
    expect((await bridge<any>(page, 'getRuntimeInfo')).process.pid).toBe(coreBefore);
    await testInfo.attach('installation-authorization-recheck', { body: await page.screenshot(), contentType: 'image/png' });
    mode('good.json');
    await begin();
    await expect(page.getByRole('button', { name: '立即重启安装', exact: true })).toBeVisible({ timeout: 90_000 });
    helperOffset = existsSync(helper) ? readFileSync(helper, 'utf8').length : 0;
    installRequested = true;
    const closed = page.waitForEvent('close', { timeout: 90_000 });
    await page.getByRole('button', { name: '立即重启安装', exact: true }).click();
    await closed;
    // No launcher is invoked here. The installed updater must restart Desktop.
    // The old CDP listener can briefly outlive its Page. Wait for the real
    // helper's new process, not merely for any listener on the same port.
    await expect.poll(helperOutput, { timeout: 120_000 }).toContain('helper-complete');
    expect(helperOutput()).toContain('installer-exit=exit code: 0');
    expect(helperOutput()).toMatch(/desktop-restarted=\d+/);
    await connect();
    const updatedRecord = identify();
    expect(updatedRecord.pid).not.toBe(beforeRecord.pid);
    expect(hash(originalProcess.appExe)).toBe(metadata.candidateInstalledSha256);
    const bundled = JSON.parse(readFileSync(path.join(path.dirname(originalProcess.appExe), 'bundled-runtime', 'stable-win32-x64.json'), 'utf8').replace(/^\uFEFF/, ''));
    expect(bundled.sourceCommit).toBe(baseline.coreCommit);
    expect(bundled.runtimeVersion).toBe(baseline.runtimeVersion);
    const runtime = await bridge<any>(page, 'getRuntimeInfo');
    expect(runtime.current.sourceCommit).toBe(baseline.coreCommit);
    expect(runtime.process.pid).not.toBe(coreBefore);
    expect(hash(path.join(home, 'config.yaml'))).toBe(userConfigSha);
    expect(hash(path.join(home, '.env'))).toBe(modelKeySha);
    await route(page, `/tasks/${id}`);
    const after = await sendChat(page, '整包升级以后，请只从本会话上下文回复暗号，不调用工具。', marker);
    expect(after.evidence.session.tool_call_count).toBe(0);
    expect(helperOutput()).toContain(`desktop-restarted=${updatedRecord.pid}`);
    expect(requests().filter(item => item.host === 'dl-desktop.hermesagent.org.cn').every(item => !item.authorizationPresent)).toBe(true);
    await testInfo.attach('actual-shell-update', { body: JSON.stringify({ metadata, beforeRecord, updatedRecord, coreBefore, coreAfter: runtime.process.pid, session: sessionEvidence(id), helper: helperOutput() }, null, 2), contentType: 'application/json' });
    await testInfo.attach('upgraded-conversation', { body: await page.screenshot(), contentType: 'image/png' });
  } catch (error) {
    await testInfo.attach('primary-shell-workflow-error', { body: String(error), contentType: 'text/plain' });
    throw error;
  } finally {
    if (fixtureStarted) {
      if (installRequested) {
        await expect.poll(helperOutput, { timeout: 120_000 }).toContain('helper-complete');
        await testInfo.attach('actual-installer-helper', { body: helperOutput(), contentType: 'text/plain' });
      }
      if (!page.isClosed()) await testInfo.attach('shell-before-cleanup', { body: await page.screenshot(), contentType: 'image/png' });
      await native({ action: 'deleteUpdateFixtureCredential', deviceId: marker });
      if (desktopRestarted) {
        if (!page.isClosed()) { identify(); await quitFromTray(); }
        else {
          const listeners = JSON.parse(ps("@(Get-NetTCPConnection -LocalPort 19229 -State Listen -ErrorAction SilentlyContinue | Select-Object OwningProcess) | ConvertTo-Json -Compress") || '[]');
          if ((Array.isArray(listeners) ? listeners : [listeners]).length) { await connect(); identify(); await quitFromTray(); }
        }
        writeFileSync(configFile, originalConfig);
        // A deliberately cached test candidate otherwise opens a global modal
        // on the next independent workflow. Remove only these exact test bytes
        // after Desktop exits; never delete an unrelated pending update.
        if (existsSync(pendingFile)) {
          const pending = JSON.parse(readFileSync(pendingFile, 'utf8'));
          const metadata = JSON.parse(readFileSync(path.join(fixture, 'metadata.json'), 'utf8'));
          expect(pending.sha256).toBe(metadata.candidateInstallerSha256);
          expect(pending.version).toBe(metadata.version);
          const packageFile = path.join(path.dirname(pendingFile), 'pending-update.exe');
          expect(hash(packageFile)).toBe(metadata.candidateInstallerSha256);
          unlinkSync(packageFile); unlinkSync(pendingFile);
        }
        if (hash(originalProcess.appExe) !== baseline.installedDesktopSha256) script('restore-shell-baseline.ps1');
        script('start.ps1');
        expect(hash(originalProcess.appExe)).toBe(baseline.installedDesktopSha256);
      }
      for (const name of ['requests.jsonl', 'events.jsonl', 'metadata.json']) if (existsSync(path.join(fixture, name))) await testInfo.attach('shell-fixture-' + name, { path: path.join(fixture, name), contentType: name.endsWith('jsonl') ? 'application/x-ndjson' : 'application/json' });
      mode('good.json', false);
      script('stop-shell-update-fixture.ps1');
    }
    for (const browser of browsers) await browser.close();
  }
});
