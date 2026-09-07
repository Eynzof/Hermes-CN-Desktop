import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, route, api, home, python } from '../fixtures';

test('CRON-002 网页变化监控、无变化零模型调用和连续运行记忆', async ({ app }, testInfo) => {
  const name = `monitor-${Date.now()}`;
  const first = `PAGE-A-${Date.now()}`;
  const second = `PAGE-B-${Date.now()}`;
  let content = first;
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(`本页唯一验证码：${content}`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/change`;
  let jobId = '';
  const totalCalls = () => Number(execFileSync(python, ['-c',
    'import sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1].replace("\\\\","/")+"?mode=ro",uri=True); print(c.execute("SELECT COALESCE(SUM(api_call_count),0) FROM sessions").fetchone()[0])', path.join(home, 'state.db')], { encoding: 'utf8' }).trim());
  try {
    await route(app, '/cron');
    await app.getByRole('button', { name: '新建任务', exact: true }).first().click();
    await app.getByLabel('名称（可选）').fill(name);
    await app.getByLabel('调度表达式').fill('every 12h');
    await app.getByLabel('发送目标').selectOption('local');
    await app.getByLabel('运行记忆', { exact: true }).selectOption('on');
    await app.getByLabel('监控网页（可选）').fill(url);
    await app.getByLabel('Prompt', { exact: true }).fill('根据系统注入的网页监控内容回答当前验证码，若上下文含有上次运行结果，也回答上次的验证码。仅格式 current=验证码 previous=上次验证码，首次 previous=NONE。不要访问网页，不调用工具，不写文件，不发送外部消息。');
    await app.getByRole('button', { name: '创建任务', exact: true }).click();
    await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
    const job = (await api(app, '/api/cron/jobs')).find((j: any) => j.name === name);
    jobId = job.id;
    expect(job.monitor_url).toBe(url);
    expect(job.context_from).toEqual(['self']);
    const runs = async () => (await api(app, `/__hermes_cron_runs/default/${jobId}?limit=30`)).runs;
    const execute = async (count: number) => {
      await app.getByRole('button', { name: '立即运行', exact: true }).click();
      await expect.poll(async () => (await runs()).length, { timeout: 90_000 }).toBe(count);
      const all = await runs();
      const result = await api(app, `/__hermes_cron_runs/default/${jobId}/${encodeURIComponent(all[0].filename)}`);
      // Separate this continuity case from WIN-012: Core output filenames
      // currently have only second precision and overwrite rapid repeats.
      const savedSecond = Math.floor(Date.now() / 1000);
      await expect.poll(() => Math.floor(Date.now() / 1000) > savedSecond, { intervals: [100] }).toBe(true);
      return result;
    };
    const a = await execute(1);
    expect(JSON.stringify(a)).toContain(first);
    const beforeUnchanged = totalCalls();
    const unchanged = await execute(2);
    expect(JSON.stringify(unchanged)).toContain('no_change (agent run suppressed)');
    expect(totalCalls(), 'An unchanged source must not call an LLM').toBe(beforeUnchanged);
    content = second;
    const b = await execute(3);
    expect(JSON.stringify(b)).toContain(second);
    expect(JSON.stringify(b)).toContain(first);
    expect(totalCalls()).toBeGreaterThan(beforeUnchanged);
    expect(requests).toBe(3);
    await app.getByRole('button', { name: '刷新', exact: true }).click();
    await expect(app.getByRole('complementary', { name: '运行历史记录' })).toContainText(/3/);
    await testInfo.attach('monitor-continuity', { body: JSON.stringify({ job, first: a, unchanged, changed: b, sourceRequests: requests, callsBeforeUnchanged: beforeUnchanged, callsAfterChanged: totalCalls() }, null, 2), contentType: 'application/json' });
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
