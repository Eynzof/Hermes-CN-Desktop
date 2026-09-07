import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, native, api, home } from '../fixtures';

test('MODEL-010 官方设备码发起、复制、正常取消与发起中关闭', async ({ app }, testInfo) => {
  const provider = 'nous';
  const startPath = `/api/providers/oauth/${provider}/start`;
  const authFile = path.join(home, 'auth.json');
  const authDigest = () => existsSync(authFile) ? createHash('sha256').update(readFileSync(authFile)).digest('hex') : null;
  const beforeDigest = authDigest();
  const beforeConfig = await api(app, '/api/config');
  const beforeProviders = await api(app, '/api/providers/oauth');
  expect(beforeProviders.providers.find((p: any) => p.id === provider)?.status.logged_in,
    'Cancellation uses the isolated, disconnected Nous identity').toBe(false);
  await app.evaluate(() => {
    const w = window as any;
    const bridge = w.hermesDesktop;
    const original = bridge.request;
    w.__oauthAcceptance = { original, events: [] };
    // Observe the actual native IPC result; preserve request, timing and bytes.
    bridge.request = async function(input: any) {
      if (!input.path.startsWith('/api/providers/oauth')) return original.call(bridge, input);
      const event: any = { path: input.path, method: input.method || 'GET', startedAt: Date.now() };
      w.__oauthAcceptance.events.push(event);
      try {
        const result = await original.call(bridge, input);
        event.status = result.status;
        event.finishedAt = Date.now();
        const body = JSON.parse(result.body || 'null');
        event.body = input.path === '/api/providers/oauth'
          ? { providers: body.providers?.map((p: any) => ({ id: p.id, logged_in: p.status.logged_in })) }
          : body;
        return result;
      } catch (error) { event.error = String(error); throw error; }
    };
  });
  const events = () => app.evaluate(() => (window as any).__oauthAcceptance.events);
  const request = (url: string, method = 'GET') => app.evaluate(async ({ url, method }) => {
    const w = window as any, token = w.__HERMES_RUNTIME__.sessionToken || w.__HERMES_SESSION_TOKEN__;
    const result = await w.hermesDesktop.request({ path: url, method,
      headers: { Authorization: `Bearer ${token}`, 'X-Hermes-Session-Token': token } });
    return { status: result.status, body: JSON.parse(result.body || 'null') };
  }, { url, method });
  const block = app.locator('[class*="oauthBlock"]');
  const row = block.locator('[class*="providerRow"]').filter({ has: app.getByText('Nous Portal', { exact: true }) });
  const modal = app.locator('[class*="modalBackdrop"]').filter({ has: app.getByText('登录 Nous Portal', { exact: true }) });
  const browserEvidence: any[] = [];
  const closeVerificationPage = async (verificationUrl: string) => {
    const expectedHost = new URL(verificationUrl).hostname;
    let target: any;
    await expect.poll(async () => {
      const windows = (await native({ action: 'systemWindows' })).windows.filter((w: any) =>
        w.type === 'Chrome_WidgetWin_1' && /Nous|portal\.nousresearch\.com/i.test(w.text));
      for (const w of windows) {
        const candidate = { window: w.text, windowClass: w.type, windowHandle: w.handle };
        await native({ action: 'externalKeys', ...candidate, keys: '^l^c{ESC}' });
        const address = (await native({ action: 'clipboard' })).text;
        try { if (new URL(address).hostname === expectedHost) { target = candidate; browserEvidence.push({ window: w, address }); return true; } } catch {}
      }
      return false;
    }, { message: 'Actual system browser opened the official Nous verification host', timeout: 30_000 }).toBe(true);
    const shot = await native({ action: 'screenshot' });
    await testInfo.attach(`official-verification-browser-${browserEvidence.length}`, { path: shot.path, contentType: 'image/png' });
    await native({ action: 'externalKeys', ...target, keys: '^w' });
  };
  try {
    await route(app, '/models');
    await row.getByRole('button', { name: '登录', exact: true }).click();
    await expect.poll(async () => (await events()).find((e: any) => e.path === startPath)?.status, { timeout: 30_000 }).toBe(200);
    const first = (await events()).find((e: any) => e.path === startPath).body;
    expect(first.flow).toBe('device_code');
    expect(new URL(first.verification_url).hostname).toBe('portal.nousresearch.com');
    await expect(modal.getByText(first.user_code, { exact: true })).toBeVisible();
    await modal.getByRole('button', { name: '复制验证码', exact: true }).click();
    expect((await native({ action: 'clipboard' })).text).toBe(first.user_code);
    await testInfo.attach('actual-device-code-modal', { body: await modal.ariaSnapshot(), contentType: 'text/plain' });
    await closeVerificationPage(first.verification_url);
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => (await events()).some((e: any) => e.method === 'DELETE' && e.path.endsWith(first.session_id) && e.body?.ok === true)).toBe(true);
    expect((await request(`/api/providers/oauth/${provider}/poll/${first.session_id}`)).status).toBe(404);
    const refreshBefore = (await events()).filter((e: any) => e.path === '/api/providers/oauth').length;
    await block.getByRole('button', { name: '刷新', exact: true }).click();
    await expect.poll(async () => (await events()).filter((e: any) => e.path === '/api/providers/oauth' && e.status === 200).length).toBeGreaterThan(refreshBefore);
    await expect(row).toContainText('未连接');
    expect(authDigest(), 'Cancelling a pending login must not write credentials').toBe(beforeDigest);
    await testInfo.attach('normal-cancel-checkpoint', { body: JSON.stringify({ sessionRemoved: true, stillDisconnected: true, authFileUnchanged: true }), contentType: 'application/json' });

    // Exercise the real network race; no response interception or delay injection.
    await row.getByRole('button', { name: '登录', exact: true }).click();
    await expect(modal.getByText('正在启动授权流程…', { exact: true })).toBeVisible();
    const starts = (await events()).filter((e: any) => e.path === startPath);
    expect(starts).toHaveLength(2);
    expect(starts[1].finishedAt, 'Must close while the actual start request is still in flight').toBeUndefined();
    await modal.getByRole('button', { name: '关闭', exact: true }).click();
    const closedAt = Date.now();
    await expect(modal).toHaveCount(0);
    await expect.poll(async () => (await events()).filter((e: any) => e.path === startPath)[1].status, { timeout: 30_000 }).toBe(200);
    const late = (await events()).filter((e: any) => e.path === startPath)[1];
    expect(late.finishedAt).toBeGreaterThan(closedAt);
    const status = await request(`/api/providers/oauth/${provider}/poll/${late.body.session_id}`);
    await testInfo.attach('closed-before-start-response', { body: JSON.stringify({ closedAt, response: late, sessionAfterClose: status }, null, 2), contentType: 'application/json' });
    // A still-pending session is a product failure, not successful cancellation.
    expect.soft(status.status, '关闭发起中的弹窗后，后返回的 OAuth 会话应被取消').toBe(404);
    if (status.status === 200) await closeVerificationPage(late.body.verification_url);
    expect((await api(app, '/api/config')).model).toEqual(beforeConfig.model);
  } finally {
    await testInfo.attach('official-browser-observations', { body: JSON.stringify(browserEvidence, null, 2), contentType: 'application/json' });
    await testInfo.attach('oauth-ui-request-events-before-cleanup', { body: JSON.stringify(await events(), null, 2), contentType: 'application/json' });
    // Remove only sessions created by this case. Direct cleanup is not a UI pass.
    for (const e of await events()) {
      if (e.path === startPath && e.body?.session_id) {
        const cleanup = await request(`/api/providers/oauth/sessions/${e.body.session_id}`, 'DELETE');
        await testInfo.attach(`session-cleanup-${e.body.session_id}`, { body: JSON.stringify(cleanup), contentType: 'application/json' });
      }
    }
    if (await modal.isVisible()) await modal.getByRole('button', { name: '关闭', exact: true }).first().click();
    await app.evaluate(() => { const w = window as any; w.hermesDesktop.request = w.__oauthAcceptance.original; delete w.__oauthAcceptance; });
    expect(authDigest()).toBe(beforeDigest);
  }
});
