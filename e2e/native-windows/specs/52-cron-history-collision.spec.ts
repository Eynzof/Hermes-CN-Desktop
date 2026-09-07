import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, route, api } from '../fixtures';

test('CRON-004 同一秒快速重复执行网页监控必须各自保留历史', async ({ app }, testInfo) => {
  const name = `rapid-monitor-${Date.now()}`;
  const arrivals: number[] = [];
  const server = createServer((_request, response) => {
    arrivals.push(Date.now());
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(name);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let jobId = '';
  try {
    await route(app, '/cron');
    await app.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await app.getByLabel('名称（可选）').fill(name);
    await app.getByLabel('调度表达式').fill('every 12h');
    await app.getByLabel('发送目标').selectOption('local');
    await app.getByLabel('监控网页（可选）').fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/change`);
    await app.getByLabel('Prompt', { exact: true }).fill('不要调用工具，只回复 READY。');
    await app.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
    jobId = (await api(app, '/api/cron/jobs')).find((j: any) => j.name === name).id;
    const runs = async () => (await api(app, `/__hermes_cron_runs/default/${jobId}?limit=30`)).runs;
    const runButton = app.getByRole('button', { name: '立即运行', exact: true });
    await runButton.click();
    await expect.poll(async () => (await runs()).length, { timeout: 90_000 }).toBe(1);
    const first = (await runs())[0];
    expect(JSON.stringify(await api(app, `/__hermes_cron_runs/default/${jobId}/${encodeURIComponent(first.filename)}`))).toContain('READY');
    // Align wall time, not application time. No clock mocking or API writes.
    await expect.poll(() => Date.now() % 1000 < 100, { intervals: [20] }).toBe(true);
    await runButton.click();
    await expect.poll(() => arrivals.length, { intervals: [20] }).toBe(2);
    await expect(runButton).toBeEnabled();
    await runButton.click();
    await expect.poll(() => arrivals.length, { intervals: [20] }).toBe(3);
    await expect(runButton).toBeEnabled();
    const all = await runs();
    await testInfo.attach('rapid-real-source-and-history', { body: JSON.stringify({ jobId, sourceArrivals: arrivals, runs: all }, null, 2), contentType: 'application/json' });
    expect(Math.floor(arrivals[1] / 1000), 'The two real executions must land in the same second').toBe(Math.floor(arrivals[2] / 1000));
    await expect.poll(async () => (await runs()).length, { timeout: 5_000 }).toBe(3);
    expect(new Set((await runs()).map((r: any) => r.filename)).size).toBe(3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (jobId) {
      await app.getByRole('button', { name: '删除', exact: true }).click();
      await app.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
      await expect.poll(async () => (await api(app, '/api/cron/jobs')).some((j: any) => j.id === jobId)).toBe(false);
    }
  }
});
