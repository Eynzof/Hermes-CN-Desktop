import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, native, root, home, sessionEvidence } from '../fixtures';

test('PTY-002 外部终端真实模型对话、档案环境和正常退出', async ({ app }, testInfo) => {
  const previous = new Set((await native({ action: 'systemWindows' })).windows.map((w: any) => w.handle));
  const marker = `EXTERNAL-${Date.now()}`;
  let handle: number | undefined;
  const observedWindow = async () => (await native({ action: 'systemWindows' })).windows.find((w: any) => w.handle === handle);
  const action = async (input: Record<string, unknown>) => {
    const window = await observedWindow();
    expect(window, 'Only the terminal opened by this test may receive input').toBeTruthy();
    return native({ window: window.text, windowClass: window.type, windowHandle: handle, ...input });
  };
  const text = async () => (await action({ action: 'externalSnapshot' })).controls
    .filter((c: any) => c.class === 'TermControl').map((c: any) => c.text || '').join('\n');
  const enter = async (value: string) => {
    await action({ action: 'externalPaste', value });
    await action({ action: 'externalKeys', keys: '{ENTER}' });
  };
  await route(app, '/console');
  await app.getByRole('button', { name: '在外部终端打开', exact: true }).click();
  try {
    await expect.poll(async () => {
      const window = (await native({ action: 'systemWindows' })).windows.find((w: any) =>
        w.type === 'CASCADIA_HOSTING_WINDOW_CLASS' && !previous.has(w.handle));
      handle = window?.handle;
      return Boolean(handle);
    }).toBe(true);
    await expect.poll(text, { timeout: 60_000 }).toContain('Welcome to Hermes Agent!');
    const welcome = await text();
    expect(welcome).toContain('deepseek-v4-flash');
    expect(welcome).toContain(home);
    const id = welcome.match(/Session:\s*(\d{8}_\d{6}_[a-f0-9]+)/)?.[1];
    expect(id, 'Read the actual CLI session ID from Windows Terminal TextPattern').toBeTruthy();
    await enter(`Reply only ${marker}. Do not use tools.`);
    // The terminal echoes the prompt. A visible marker alone cannot prove an
    // answer: require the separately persisted assistant message and billing.
    await expect.poll(() => sessionEvidence(id!).messages.filter((m: any) => m.role === 'assistant').at(-1)?.content?.trim(),
      { timeout: 120_000 }).toBe(marker);
    const evidence = sessionEvidence(id!);
    expect(evidence.session.source).toBe('cli');
    expect(evidence.session.model).toBe('deepseek-v4-flash');
    expect(evidence.session.billing_provider).toBe('deepseek');
    expect(evidence.session.output_tokens).toBeGreaterThan(0);
    expect(evidence.session.tool_call_count).toBe(0);
    await testInfo.attach('external-cli-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await testInfo.attach('external-cli-screen-text', { body: await text(), contentType: 'text/plain' });
    const shot = await native({ action: 'screenshot' });
    await testInfo.attach('external-cli-native-window', { path: shot.path, contentType: 'image/png' });
    await enter('/quit');
    await expect.poll(text, { timeout: 30_000 }).toContain(`PS ${home}>`);
    const file = path.join(root, 'workspace', marker + '.json');
    await enter(`[ordered]@{home=$env:HERMES_HOME;profile=$env:HERMES_PROFILE;cwd=(Get-Location).Path;shim=(Get-Command hermes).Source} | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 '${file}'`);
    await expect.poll(() => existsSync(file) && readFileSync(file, 'utf8').trim().endsWith('}')).toBe(true);
    const environment = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    expect(environment.home.toLowerCase()).toBe(home.toLowerCase());
    expect(environment.cwd.toLowerCase()).toBe(home.toLowerCase());
    expect(environment.profile).toBe('default');
    // Core installs equivalent .cmd and .bat shims; PowerShell's PATHEXT
    // ordering resolves .bat first on the acceptance host.
    expect(path.dirname(environment.shim).toLowerCase()).toBe(path.join(root, 'runtime', 'desktop-bin').toLowerCase());
    expect(path.basename(environment.shim).toLowerCase()).toMatch(/^hermes\.(bat|cmd)$/);
    expect(readFileSync(environment.shim, 'utf8')).toBe(readFileSync(path.join(root, 'runtime', 'desktop-bin', 'hermes.cmd'), 'utf8'));
    await testInfo.attach('external-shell-environment', { body: JSON.stringify(environment, null, 2), contentType: 'application/json' });
    await enter('exit');
    await expect.poll(observedWindow).toBeUndefined();
  } finally {
    if (handle && await observedWindow()) {
      await testInfo.attach('external-terminal-final-text', { body: await text(), contentType: 'text/plain' });
      // Close only this newly observed window; never kill the shared Terminal
      // host, which also owns unrelated user terminals.
      await action({ action: 'externalKeys', keys: '%{F4}' });
    }
    if (await app.getByRole('button', { name: '关闭终端', exact: true }).isEnabled()) {
      await app.getByRole('button', { name: '关闭终端', exact: true }).click();
    }
  }
});
