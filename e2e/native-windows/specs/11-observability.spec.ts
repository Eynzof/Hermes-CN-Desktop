import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, api, native, nativeDialog, root, home } from '../fixtures';

test('OBS-001 刷新健康检查、复制诊断并与真实模型可用性核对', async ({ app }, testInfo) => {
  await chat(app, '这是健康检查验收。请只回复 HEALTH-OK。', 'HEALTH-OK');
  await route(app, '/health');
  await app.getByRole('button', { name: '刷新检查', exact: true }).click();
  await expect(app.getByRole('button', { name: '刷新检查', exact: true })).toBeEnabled();
  await app.getByRole('button', { name: '复制诊断 JSON', exact: true }).click();
  const diagnostic = JSON.parse((await native({ action: 'clipboard' })).text);
  expect(diagnostic.dashboard.hermes_home.toLowerCase()).toBe(home.toLowerCase());
  expect(diagnostic.env.DEEPSEEK_API_KEY.is_set).toBe(true);
  expect(JSON.stringify(diagnostic.model)).toContain('deepseek-v4-flash');
  await expect(app.getByRole('main')).not.toContainText('模型调用需要 API Key 或 OAuth 凭证');
  await testInfo.attach('health-diagnostic', { body: JSON.stringify(diagnostic, null, 2), contentType: 'application/json' });
});

test('OBS-002 真实对话 Token 增量、模型汇总、周期和性能视图', async ({ app }, testInfo) => {
  const before = await api(app, '/api/analytics/usage?days=7');
  const { evidence } = await chat(app, '这是用量核算测试。请只回复 ANALYTICS-OK。', 'ANALYTICS-OK');
  await route(app, '/analytics');
  await app.getByRole('radio', { name: '7 天', exact: true }).click();
  await app.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(app.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  const after = await api(app, '/api/analytics/usage?days=7');
  expect(after.totals.total_input - before.totals.total_input).toBeGreaterThanOrEqual(evidence.session.input_tokens);
  expect(after.totals.total_output - before.totals.total_output).toBeGreaterThanOrEqual(evidence.session.output_tokens);
  expect(after.totals.total_api_calls).toBeGreaterThan(before.totals.total_api_calls);
  expect(after.by_model.find((m: any) => m.model === 'deepseek-v4-flash' && m.provider === 'deepseek').api_calls).toBeGreaterThan(0);
  await expect(app.getByRole('main')).toContainText('deepseek-v4-flash');
  for (const period of ['30 天', '90 天']) {
    await app.getByRole('radio', { name: period, exact: true }).click();
    await expect(app.getByRole('radio', { name: period, exact: true })).toBeChecked();
  }
  await app.getByRole('tab', { name: '性能指标', exact: true }).click();
  await expect(app.getByRole('tab', { name: '性能指标', exact: true })).toHaveAttribute('aria-selected', 'true');
  await testInfo.attach('analytics-delta', { body: JSON.stringify({ before: before.totals, after: after.totals, session: evidence.session }, null, 2), contentType: 'application/json' });
});

test('OBS-003 真实日志搜索过滤、复制和原生 LOG 与 JSONL 导出', async ({ app }, testInfo) => {
  await chat(app, '请只回复 LOG-EXPORT-OK。', 'LOG-EXPORT-OK');
  await route(app, '/logs');
  const filters = app.getByRole('region', { name: '日志筛选' });
  await filters.getByRole('button', { name: '500', exact: true }).click();
  const search = app.getByRole('textbox', { name: '搜索日志' });
  await search.fill('tui turn finished:');
  await expect(app.getByRole('log')).toContainText('tui turn finished:');
  await app.getByRole('button', { name: '复制可见日志', exact: true }).click();
  const copied = (await native({ action: 'clipboard' })).text;
  expect(copied).toContain('tui turn finished:');
  await app.getByRole('button', { name: '导出 .log', exact: true }).click();
  await nativeDialog('导出 Hermes 日志');
  await expect(app.getByText('已取消导出。', { exact: true })).toBeVisible();
  for (const [label, extension] of [['导出 .log', 'log'], ['导出 JSONL', 'jsonl']]) {
    const file = path.join(root, 'reports', `log-${Date.now()}.${extension}`);
    await app.getByRole('button', { name: label, exact: true }).click();
    await nativeDialog('导出 Hermes 日志', file);
    await expect(app.getByText(/已导出 /).last()).toBeVisible();
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('tui turn finished:');
    if (extension === 'jsonl') expect(content.trim().split('\n').map(line => JSON.parse(line)).length).toBeGreaterThan(0);
    await testInfo.attach(`export-${extension}`, { path: file });
  }
  await search.fill('definitely-no-matching-log-unique');
  await expect(app.getByRole('log')).not.toContainText('tui turn finished:');
  await app.getByRole('button', { name: '清空筛选', exact: true }).click();
  await expect(search).toHaveValue('');
});

test('SET-004 高级配置搜索、取消编辑、保存及重新加载', async ({ app }) => {
  const config = await api(app, '/api/config');
  const original = config.file_read_max_chars;
  expect(typeof original).toBe('number');
  await route(app, '/config');
  const main = app.getByRole('main');
  const search = app.getByPlaceholder('搜索配置项…');
  await search.fill('file_read_max_chars');
  await expect(main.getByRole('button', { name: '编辑', exact: true })).toHaveCount(1);
  await main.getByRole('button', { name: '编辑', exact: true }).click();
  await main.getByRole('textbox').nth(1).fill(String(original + 100));
  await main.getByRole('button', { name: '取消', exact: true }).click();
  expect((await api(app, '/api/config')).file_read_max_chars).toBe(original);
  await main.getByRole('button', { name: '编辑', exact: true }).click();
  await main.getByRole('textbox').nth(1).fill(String(original + 100));
  await main.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/config')).file_read_max_chars).toBe(original + 100);
  await app.reload();
  await search.fill('file_read_max_chars');
  await expect(main).toContainText(String(original + 100));
  await main.getByRole('button', { name: '编辑', exact: true }).click();
  await main.getByRole('textbox').nth(1).fill(String(original));
  await main.getByRole('button', { name: '保存', exact: true }).click();
  await expect.poll(async () => (await api(app, '/api/config')).file_read_max_chars).toBe(original);
});
