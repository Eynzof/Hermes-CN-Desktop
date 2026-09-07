import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { test, expect, route, home } from '../fixtures';

test('IM-WEIXIN-003 官方二维码自然过期、自动刷新与最终停止轮询', async ({ app }, testInfo) => {
  test.setTimeout(570_000);
  const envFile = path.join(home, '.env');
  const digest = () => existsSync(envFile) ? createHash('sha256').update(readFileSync(envFile)).digest('hex') : null;
  const beforeDigest = digest();
  const state = await app.evaluate(() => (window as any).hermesDesktop.imOnboardingState({ platform: 'weixin' }));
  expect(state.configured.WEIXIN_ACCOUNT_ID?.isSet ?? false).toBe(false);
  await app.evaluate(() => {
    const w = window as any, bridge = w.hermesDesktop;
    w.__weixinExpiryAcceptance = { events: [], originals: {} };
    for (const name of ['imOnboardingBegin', 'imOnboardingPoll', 'imOnboardingApply']) {
      const original = bridge[name];
      w.__weixinExpiryAcceptance.originals[name] = original;
      bridge[name] = async function(input: any) {
        const event: any = { name, input, startedAt: Date.now() };
        w.__weixinExpiryAcceptance.events.push(event);
        try { const result = await original.call(bridge, input); event.result = result; return result; }
        catch (error) { event.error = String(error); throw error; }
        finally { event.finishedAt = Date.now(); }
      };
    }
  });
  const events = () => app.evaluate(() => (window as any).__weixinExpiryAcceptance.events);
  const qr = app.getByRole('img', { name: '扫码接入二维码', exact: true });
  const checkPixels = async (expected: string, label: string) => {
    await expect(qr).toBeVisible();
    const bytes = await qr.screenshot();
    const png = PNG.sync.read(bytes);
    const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    expect(decoded?.data).toBe(expected);
    await testInfo.attach(label, { body: bytes, contentType: 'image/png' });
  };
  try {
    await route(app, '/im/weixin');
    await app.getByRole('button', { name: '生成二维码', exact: true }).click();
    await expect.poll(async () => (await events()).find((e: any) => e.name === 'imOnboardingBegin')?.result?.status).toBe('pending');
    const flow = (await events()).find((e: any) => e.name === 'imOnboardingBegin').result;
    expect(flow.expiresAtMs - Date.now()).toBeGreaterThan(450_000);
    expect(flow.expiresAtMs - Date.now()).toBeLessThanOrEqual(480_000);
    await checkPixels(flow.qrScanData, 'initial-qr');
    const initialSource = await qr.getAttribute('src');
    await testInfo.attach('natural-expiry-start', { body: JSON.stringify({ flowId: flow.flowId, startedAt: Date.now(), expiresAtMs: flow.expiresAtMs }), contentType: 'application/json' });
    // Observe real provider expiry and native polling for the entire advertised
    // lifetime. Existing 15s pending-poll errors belong to IM-WEIXIN-002; this
    // workflow never changes the clock, timers, responses or native timeout.
    await expect.poll(async () => (await events()).some((e: any) => e.result?.status === 'expired_refreshed'),
      { timeout: Math.max(1, flow.expiresAtMs - Date.now()), intervals: [3000], message: 'Official QR naturally expires and the installed app refreshes it' }).toBe(true);
    const refreshed = (await events()).find((e: any) => e.result?.status === 'expired_refreshed');
    expect(refreshed.result.flowId).toBe(flow.flowId);
    expect(refreshed.result.qrScanData).not.toBe(flow.qrScanData);
    await expect(qr).not.toHaveAttribute('src', initialSource!);
    await checkPixels(refreshed.result.qrScanData, 'automatically-refreshed-qr');
    await testInfo.attach('natural-refresh', { body: JSON.stringify(refreshed, null, 2), contentType: 'application/json' });
    await testInfo.attach('natural-refresh-page', { body: await app.screenshot(), contentType: 'image/png' });
    await expect.poll(async () => (await events()).some((e: any) => e.result?.status === 'expired'),
      { timeout: Math.max(1, flow.expiresAtMs - Date.now()) + 25_000, intervals: [3000], message: 'The finite QR flow reaches its real final expiry' }).toBe(true);
    await expect(app.locator('[class*="traceRow"]')).toContainText('已过期');
    const expiredAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 4000));
    expect((await events()).filter((e: any) => e.name === 'imOnboardingPoll' && e.startedAt > expiredAt),
      'No polling restarts after final expiry').toHaveLength(0);
    await expect(app.getByRole('button', { name: '生成二维码', exact: true })).toBeEnabled();
    await testInfo.attach('final-expiry-page', { body: await app.screenshot(), contentType: 'image/png' });
  } finally {
    await testInfo.attach('last-expiry-page', { body: await app.screenshot(), contentType: 'image/png' });
    await route(app, '/health');
    await expect.poll(async () => (await events()).filter((e: any) => !e.finishedAt).length, { timeout: 20_000 }).toBe(0);
    const recorded = await events();
    await testInfo.attach('natural-expiry-native-events', { body: JSON.stringify(recorded, null, 2), contentType: 'application/json' });
    await app.evaluate(() => {
      const w = window as any;
      for (const [name, original] of Object.entries(w.__weixinExpiryAcceptance.originals)) w.hermesDesktop[name] = original;
      delete w.__weixinExpiryAcceptance;
    });
    expect(recorded.filter((e: any) => e.name === 'imOnboardingApply')).toHaveLength(0);
    expect(digest()).toBe(beforeDigest);
  }
});
