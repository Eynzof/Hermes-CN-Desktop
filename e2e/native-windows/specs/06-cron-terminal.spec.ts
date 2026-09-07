import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, api, root } from '../fixtures';

test('CRON-001 定时任务创建编辑、暂停恢复、真实执行历史和删除', async ({ app }, testInfo) => {
  const name = `cron-${Date.now()}`;
  const file = path.join(root, 'workspace', name + '.txt');
  await route(app, '/cron');
  await app.getByRole('button', { name: '新建任务', exact: true }).first().click();
  await app.getByLabel('名称（可选）').fill(name);
  await app.getByLabel('调度表达式').fill('every 12h');
  await app.getByLabel('发送目标').selectOption('local');
  await app.getByLabel('Prompt', { exact: true }).fill(`实际使用文件写入工具创建 UTF-8 文件 ${file.replaceAll('\\', '/')}，内容仅为 ${name}。完成后回复相同标记。只操作该测试文件，不发送外部消息。`);
  await app.getByRole('button', { name: '创建任务', exact: true }).click();
  await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
  const jobs = await api(app, '/api/cron/jobs');
  const job = jobs.find((job: any) => job.name === name);
  expect(job.deliver).toBe('local');
  await app.getByRole('button', { name: '编辑', exact: true }).click();
  await app.getByLabel('运行记忆', { exact: true }).selectOption('on');
  await app.getByRole('button', { name: '保存修改', exact: true }).click();
  await expect(app.getByRole('heading', { name, exact: true })).toBeVisible();
  expect((await api(app, '/api/cron/jobs')).find((j: any) => j.id === job.id).context_from).toEqual(['self']);
  await app.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(app.getByRole('button', { name: '恢复', exact: true })).toBeEnabled();
  await app.getByRole('combobox', { name: '状态筛选' }).selectOption('paused');
  await expect(app.getByRole('complementary', { name: '定时任务列表' })).toContainText(name);
  await app.getByRole('combobox', { name: '状态筛选' }).selectOption('all');
  await app.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(app.getByRole('button', { name: '暂停', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: '立即运行', exact: true }).click();
  await expect.poll(() => existsSync(file), { timeout: 100_000 }).toBe(true);
  expect(readFileSync(file, 'utf8').trim()).toBe(name);
  await expect.poll(async () => (await api(app, `/__hermes_cron_runs/default/${job.id}?limit=30`)).runs.length, { timeout: 60_000 }).toBeGreaterThan(0);
  const runs = await api(app, `/__hermes_cron_runs/default/${job.id}?limit=30`);
  const detail = await api(app, `/__hermes_cron_runs/default/${job.id}/${encodeURIComponent(runs.runs[0].filename)}`);
  await testInfo.attach('cron-run', { body: JSON.stringify({ job, runs, detail }, null, 2), contentType: 'application/json' });
  await app.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(app.getByRole('complementary', { name: '运行历史记录' })).not.toContainText('尚无运行记录');
  await app.getByRole('button', { name: '删除', exact: true }).click();
  await app.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(app.getByRole('heading', { name, exact: true })).toHaveCount(0);
  await expect.poll(async () => (await api(app, '/api/cron/jobs')).some((j: any) => j.id === job.id)).toBe(false);
});

test('PTY-001 原生终端执行真实命令、快捷命令、关闭和重开', async ({ app }, testInfo) => {
  const marker = `pty-${Date.now()}`;
  const file = path.join(root, 'workspace', marker + '.txt');
  await app.evaluate(() => {
    (window as any).__e2eTerminal = [];
    (window as any).__e2eTerminalOff = (window as any).hermesDesktop.onTerminalOutput((event: any) => (window as any).__e2eTerminal.push(event));
  });
  await route(app, '/console');
  await expect(app.getByRole('button', { name: '关闭终端', exact: true })).toBeEnabled({ timeout: 30_000 });
  const input = app.locator('.xterm-helper-textarea');
  await input.focus();
  // The embedded Windows terminal uses ComSpec (cmd.exe); the external
  // terminal is PowerShell. Exercise the actual shell chosen by Desktop.
  await input.pressSequentially(`echo ${marker}>"${file}"`, { delay: 1 });
  await input.press('Enter');
  await expect.poll(() => existsSync(file)).toBe(true);
  expect(readFileSync(file, 'utf8').trim()).toBe(marker);
  await app.getByRole('button', { name: /^查看可用命令 hermes --help / }).click();
  await expect.poll(() => app.evaluate(() => (window as any).__e2eTerminal.filter((e: any) => e.kind === 'data').map((e: any) => e.data).join(''))).toContain('usage:');
  await testInfo.attach('terminal-output', { body: await app.evaluate(() => (window as any).__e2eTerminal.filter((e: any) => e.kind === 'data').map((e: any) => e.data).join('')), contentType: 'text/plain' });
  await app.getByRole('button', { name: '关闭终端', exact: true }).click();
  await expect(app.getByRole('button', { name: '关闭终端', exact: true })).toBeDisabled();
  await app.evaluate(() => (window as any).__e2eTerminalOff());
  await app.getByRole('button', { name: '重新打开', exact: true }).click();
  await expect(app.getByRole('button', { name: '关闭终端', exact: true })).toBeEnabled({ timeout: 30_000 });
  await app.getByRole('button', { name: '关闭终端', exact: true }).click();
});
