import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, route, native, chat, root, python } from '../fixtures';

function receipts() {
  return JSON.parse(execFileSync(python, [path.join(root, 'native-windows', 'scripts', 'notification-evidence.py')], { encoding: 'utf8' }));
}

test('SET-002 通知配置持久化、Windows 实际投递与真实任务完成提醒', async ({ app }, testInfo) => {
  const labels = ['系统通知', '提示音', '任务完成时通知', '需要权限确认时通知', '仅窗口在后台时通知'];
  const row = (label: string) => app.getByText(label, { exact: true }).locator('..').locator('..');
  const set = (label: string, value: string) => row(label).getByRole('button', { name: value, exact: true }).click();
  await route(app, '/notifications');
  const previous = await Promise.all(labels.map(label => row(label).locator('button[data-active="true"]').innerText()));
  try {
    for (const label of labels) {
      await set(label, '关闭');
      await expect(row(label).getByRole('button', { name: '关闭', exact: true })).toHaveAttribute('data-active', 'true');
    }
    const initial = receipts();
    const latest = Math.max(0, ...initial.map((item: any) => item.ArrivalTime));
    await app.getByRole('button', { name: '测试', exact: true }).click();
    await expect(app.getByRole('main')).toContainText('本次测试没有任何提醒');
    expect(receipts().filter((item: any) => item.ArrivalTime > latest)).toHaveLength(0);
    for (const label of labels.slice(0, 4)) await set(label, '开启');
    await app.reload();
    for (const label of labels.slice(0, 4)) await expect(row(label).getByRole('button', { name: '开启', exact: true })).toHaveAttribute('data-active', 'true');
    await app.getByRole('button', { name: '测试', exact: true }).click();
    await expect(app.getByRole('main')).toContainText('已发送，请查看系统通知');
    await expect.poll(() => receipts().filter((item: any) => item.ArrivalTime > latest && item.Payload.includes('Hermes 通知测试')).length).toBeGreaterThan(0);
    const afterTest = Math.max(...receipts().map((item: any) => item.ArrivalTime));
    await chat(app, '这是通知验收，请只回复 NOTIFICATION-COMPLETE。', 'NOTIFICATION-COMPLETE');
    await expect.poll(() => receipts().filter((item: any) => item.ArrivalTime > afterTest && item.Payload.includes('任务完成')).length).toBeGreaterThan(0);
    await native({ action: 'notificationCenter' });
    const screenshot = await native({ action: 'screenshot' });
    await testInfo.attach('windows-notification-center', { path: screenshot.path, contentType: 'image/png' });
    await testInfo.attach('windows-notification-receipts', { body: JSON.stringify(receipts().filter((item: any) => item.ArrivalTime > latest), null, 2), contentType: 'application/json' });
    await native({ action: 'notificationCenter' });
  } finally {
    await route(app, '/notifications');
    for (let index = 0; index < labels.length; index++) await set(labels[index], previous[index]);
  }
});
