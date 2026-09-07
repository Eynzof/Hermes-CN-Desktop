import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { test, expect, route, native, home, root, python } from '../fixtures';

for (const [platform, id, title] of [
  ['feishu', 'IM-FEISHU-002', '飞书'],
  ['weixin', 'IM-WEIXIN-002', '微信'],
] as const) {
  test(`${id} ${title}官方二维码生成、像素解码、复制、重新生成与离页停止轮询`, async ({ app }, testInfo) => {
    const envFile = path.join(home, '.env');
    const digest = () => existsSync(envFile) ? createHash('sha256').update(readFileSync(envFile)).digest('hex') : null;
    const beforeDigest = digest();
    const state = () => app.evaluate(platform => (window as any).hermesDesktop.imOnboardingState({ platform }), platform);
    const beforeState = await state();
    const key = platform === 'feishu' ? 'FEISHU_APP_ID' : 'WEIXIN_ACCOUNT_ID';
    expect(beforeState.configured[key]?.isSet ?? false, 'Use the isolated unbound test profile').toBe(false);
    await app.evaluate(() => {
      const w = window as any, bridge = w.hermesDesktop;
      w.__imQrAcceptance = { events: [], originals: {} };
      for (const name of ['imOnboardingBegin', 'imOnboardingPoll', 'imOnboardingApply']) {
        const original = bridge[name];
        w.__imQrAcceptance.originals[name] = original;
        bridge[name] = async function(input: any) {
          const event: any = { name, input, startedAt: Date.now() };
          w.__imQrAcceptance.events.push(event);
          try {
            const result = await original.call(bridge, input);
            event.result = result;
            return result;
          } catch (error) { event.error = String(error); throw error; }
          finally { event.finishedAt = Date.now(); }
        };
      }
    });
    const events = () => app.evaluate(() => (window as any).__imQrAcceptance.events);
    const begins = async () => (await events()).filter((e: any) => e.name === 'imOnboardingBegin');
    const image = app.getByRole('img', { name: '扫码接入二维码', exact: true });
    const qrEvidence: any[] = [];
    const decodeAndCopy = async (flow: any, index: number) => {
      await expect(image).toBeVisible();
      const bytes = await image.screenshot();
      const png = PNG.sync.read(bytes);
      const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
      expect(decoded, 'Actual rendered QR pixels must be decodable').toBeTruthy();
      expect(decoded!.data).toBe(flow.qrScanData);
      await app.getByRole('button', { name: '复制二维码内容', exact: true }).click();
      expect((await native({ action: 'clipboard' })).text).toBe(decoded!.data);
      qrEvidence.push({ flowId: flow.flowId, decoded: decoded!.data, width: png.width, height: png.height, status: flow.status });
      await testInfo.attach(`rendered-qr-${index}`, { body: bytes, contentType: 'image/png' });
      await testInfo.attach(`qr-page-${index}`, { body: await app.screenshot(), contentType: 'image/png' });
    };
    try {
      await route(app, `/im/${platform}`);
      await expect(app.getByRole('button', { name: '复制二维码内容', exact: true })).toBeDisabled();
      await app.getByRole('button', { name: '生成二维码', exact: true }).click();
      await expect.poll(async () => {
        const e = (await begins())[0];
        return e?.error || e?.result?.status;
      }, { timeout: 35_000, message: 'Native onboarding receives a real official QR response' }).toBe('pending');
      const first = (await begins())[0].result;
      expect(first.platform).toBe(platform);
      expect(first.expiresAtMs).toBeGreaterThan(Date.now());
      await decodeAndCopy(first, 1);
      const firstImage = await image.getAttribute('src');
      await expect(app.getByRole('button', { name: /^(保存并启动网关|重新启动网关)$/ }),
        'An unscanned QR must not enable credential installation').toBeDisabled();
      const shot = await native({ action: 'screenshot' });
      await testInfo.attach('native-qr-page', { path: shot.path, contentType: 'image/png' });

      await app.getByRole('button', { name: '立即检查', exact: true }).click({ timeout: 30_000 });
      await expect.configure({ soft: true }).poll(async () => (await events()).some((e: any) => e.name === 'imOnboardingPoll' && e.input.flowId === first.flowId && e.result?.status === 'pending'),
        { timeout: 35_000, message: 'Official polling confirms the unscanned QR is pending' }).toBe(true);
      if (platform === 'weixin' && !(await events()).some((e: any) => e.name === 'imOnboardingPoll' && e.result?.status === 'pending')) {
        const diagnostic = execFileSync(python, [path.join(root, 'native-windows', 'scripts', 'diagnose-weixin-poll.py')],
          { windowsHide: true, encoding: 'utf8', timeout: 60_000 });
        await testInfo.attach('official-long-poll-diagnostic-not-desktop-pass', { body: diagnostic, contentType: 'application/json' });
      }
      await app.getByRole('button', { name: '生成二维码', exact: true }).click({ timeout: 30_000 });
      await expect.poll(async () => {
        const e = (await begins())[1];
        return e?.error || e?.result?.status;
      }, { timeout: 35_000 }).toBe('pending');
      const second = (await begins())[1].result;
      expect(second.flowId).not.toBe(first.flowId);
      expect(second.qrScanData).not.toBe(first.qrScanData);
      await expect(image).not.toHaveAttribute('src', firstImage!);
      await decodeAndCopy(second, 2);

      await route(app, '/health');
      const leftAt = Date.now();
      await expect.poll(async () => (await events()).filter((e: any) => e.name === 'imOnboardingPoll' && !e.finishedAt).length,
        { timeout: 20_000 }).toBe(0);
      // Observe one complete real polling interval after leaving, plus margin.
      const observationMs = (platform === 'weixin' ? 1500 : Math.max(2, second.intervalSeconds || 5) * 1000) + 750;
      expect(observationMs).toBeLessThanOrEqual(16_000);
      await new Promise(resolve => setTimeout(resolve, observationMs));
      expect((await events()).filter((e: any) => e.name === 'imOnboardingPoll' && e.startedAt > leftAt),
        'Leaving the QR page must stop scheduling new polling requests').toHaveLength(0);
      await route(app, `/im/${platform}`);
      await expect(app.getByRole('button', { name: '复制二维码内容', exact: true })).toBeDisabled();
      await expect(image).toHaveCount(0);
      expect((await state()).configured).toEqual(beforeState.configured);
      expect(digest(), 'Generating and abandoning QR codes must not persist credentials').toBe(beforeDigest);
      await testInfo.attach('left-page-checkpoint', { body: JSON.stringify({ leftAt, observationMs, noNewPolling: true, noPersistedCredentials: true }), contentType: 'application/json' });
    } finally {
      await testInfo.attach('im-page-before-leave', { body: await app.screenshot(), contentType: 'image/png' });
      await route(app, '/health');
      await expect.poll(async () => (await events()).filter((e: any) => !e.finishedAt).length, { timeout: 20_000 }).toBe(0);
      const recorded = await events();
      await testInfo.attach('native-im-command-events', { body: JSON.stringify(recorded, null, 2), contentType: 'application/json' });
      await testInfo.attach('decoded-qr-evidence', { body: JSON.stringify(qrEvidence, null, 2), contentType: 'application/json' });
      await app.evaluate(() => {
        const w = window as any;
        for (const [name, original] of Object.entries(w.__imQrAcceptance.originals)) w.hermesDesktop[name] = original;
        delete w.__imQrAcceptance;
      });
      expect(recorded.filter((e: any) => e.name === 'imOnboardingApply')).toHaveLength(0);
      expect(digest()).toBe(beforeDigest);
    }
  });
}
