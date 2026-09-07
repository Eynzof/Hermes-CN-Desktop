import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, native, root, python, baseline } from '../fixtures';

test('OBS-004 真实事件筛选、详情、暂停清空、JSON 与原生 Debug 包导出', async ({ app }, testInfo) => {
  const { id } = await chat(app, '请只回复 DEBUG-EVENT-READY。', 'DEBUG-EVENT-READY');
  await route(app, '/debug');
  await app.getByRole('button', { name: '暂停采集', exact: true }).click();
  await app.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const events = JSON.parse((await native({ action: 'clipboard' })).text);
  expect(events.some((e: any) => JSON.stringify(e).includes(id))).toBe(true);
  await app.getByRole('button', { name: 'Gateway', exact: true }).click();
  await app.getByPlaceholder('搜索 summary…').fill('message');
  const event = app.getByRole('button').filter({ hasText: /\[gateway\]message/ }).first();
  await expect(event).toBeVisible();
  await event.click();
  await expect(app.getByRole('main').locator('pre').first()).toBeVisible();
  await app.getByPlaceholder('搜索 summary…').fill('no-such-event-unique');
  await expect(app.getByText('（暂无匹配条目）', { exact: true })).toBeVisible();
  await app.getByPlaceholder('搜索 summary…').fill('');
  await app.getByRole('button', { name: '全部', exact: true }).first().click();
  for (const level of ['error', 'warn', 'info']) {
    await app.getByRole('button', { name: level, exact: true }).click();
    await expect(app.getByRole('button', { name: level, exact: true })).toHaveAttribute('data-active', 'true');
  }
  await app.getByRole('button', { name: '全部', exact: true }).nth(1).click();
  await app.getByRole('button', { name: '导出 debug 包', exact: true }).click();
  const notice = app.getByText(/已导出 .* 的 debug 包，共/);
  await expect(notice).toBeVisible({ timeout: 60_000 });
  const zip = (await notice.innerText()).split('已打开：')[1].trim();
  expect(existsSync(zip)).toBe(true);
  const report = JSON.parse(execFileSync(python, [fileURLToPath(new URL('../scripts/inspect-debug.py', import.meta.url)), zip, path.join(root, 'secrets', 'deepseek.env')], { encoding: 'utf8' }));
  expect(report.badCrc).toBeNull();
  expect(report.secretFiles).toEqual([]);
  expect(report.manifest.appVersion).toBe(baseline.desktopVersion);
  expect(report.eventCount).toBeGreaterThan(0);
  expect(report.names.some((name: string) => name.includes('logs/') && name.endsWith('.log'))).toBe(true);
  await testInfo.attach('debug-bundle-inspection', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  await app.getByRole('button', { name: '清空', exact: true }).click();
  await app.getByRole('button', { name: '导出 JSON', exact: true }).click();
  expect(JSON.parse((await native({ action: 'clipboard' })).text)).toEqual([]);
  await app.getByRole('button', { name: '暂停采集', exact: true }).click();
});
