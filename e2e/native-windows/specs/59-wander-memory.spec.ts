import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, native, root, baseline } from '../fixtures';
import type { Page, TestInfo } from '@playwright/test';

const origin = 'http://127.0.0.1:18400';
const callLog = path.join(root, 'reports', 'wander-model-calls.ndjson');
let started = 0;

async function records() {
  const response = await fetch(origin + '/v1/memories');
  expect(response.ok).toBe(true);
  return (await response.json()).results as any[];
}

function calls() {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(item => item.time >= started);
}

async function proveModel(marker: string, info: TestInfo) {
  // The observer receives the original urllib response bytes from the public
  // provider. A UI answer/health badge alone does not prove a real model call.
  await expect.poll(() => {
    const events = calls();
    const ids = events.filter(e => e.event === 'request' && JSON.stringify(e.messages).includes(marker)).map(e => e.callId);
    return ids.filter(id => events.some(e => e.callId === id && e.event === 'eof') && events.some(e => e.callId === id && e.payload?.usage?.completion_tokens > 0)).length;
  }, { timeout: 120_000, message: 'Real DeepSeek SSE completion and positive provider usage' }).toBeGreaterThan(0);
  const events = calls();
  const requests = events.filter(e => e.event === 'request');
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) {
    expect(request.url).toBe(baseline.baseUrl + '/chat/completions');
    expect(request.model).toBe(baseline.model);
  }
  expect(events.filter(e => e.event === 'error')).toEqual([]);
  await info.attach('real-deepseek-transport', { body: JSON.stringify(events, null, 2), contentType: 'application/json' });
}

async function store(app: Page, text: string, metadata = '') {
  await route(app, '/wander-memory/memories');
  await app.getByPlaceholder('memory text…', { exact: true }).fill(text);
  await app.getByPlaceholder(/metadata \(optional/).fill(metadata);
  await app.getByRole('button', { name: 'store memory', exact: true }).click();
  await expect(app.locator('article', { hasText: text })).toBeVisible({ timeout: 120_000 });
  const matching = (await records()).filter(item => item.memory === text || item.text === text);
  expect(matching).toHaveLength(1);
  return matching[0];
}

async function remove(app: Page, text: string) {
  await route(app, '/wander-memory/memories');
  await app.getByPlaceholder(/search memories/).fill(text);
  await app.getByRole('button', { name: '搜索', exact: true }).click();
  const card = app.locator('article', { hasText: text }).first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /删除记忆/ }).click();
  await app.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
  await expect(card).toBeHidden();
  expect((await records()).filter(item => JSON.stringify(item).includes(text))).toHaveLength(0);
}

test.beforeAll(() => {
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'start-wander.ps1'), '-Root', root], { encoding: 'utf8', timeout: 100_000, windowsHide: true });
});

test.beforeEach(async ({ app }, info) => {
  started = Date.now() / 1000;
  // Extraction can create facts that do not repeat the unique case marker.
  // Clear this framework-owned MemOS inventory through its actual UI between
  // cases, so those facts cannot collide with the next independent scenario.
  const previous = await records();
  await info.attach('wander-inventory-before-isolation', { body: JSON.stringify(previous, null, 2), contentType: 'application/json' });
  await route(app, '/wander-memory/memories');
  for (const item of previous) {
    const button = app.getByRole('button', { name: `删除记忆 ${item.id.slice(0, 8)}`, exact: true });
    await button.click();
    await app.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click();
    await expect(button).toBeHidden();
  }
  expect(await records()).toHaveLength(0);
});

test.afterEach(async ({}, info) => {
  await info.attach('wander-service-provenance', { path: path.join(root, 'reports', 'wander-fixture.json'), contentType: 'application/json' });
  await info.attach('wander-source-manifest', { path: path.join(root, 'reports', 'wander-source-manifest.json'), contentType: 'application/json' });
  await info.attach('wander-provider-events', { body: JSON.stringify(calls(), null, 2), contentType: 'application/json' });
  await info.attach('wander-final-inventory', { body: JSON.stringify(await records(), null, 2), contentType: 'application/json' });
});

test('WANDER-001 本地 MemOS 状态、端点发现与维护', async ({ app }, info) => {
  await route(app, '/wander-memory/status');
  const health = app.locator('section', { has: app.getByRole('heading', { name: 'health', exact: true }) });
  await expect(health.getByText('ok', { exact: true })).toBeVisible();
  await expect(health.getByText(baseline.model, { exact: true })).toBeVisible();
  const models = app.locator('section', { has: app.getByRole('heading', { name: 'models', exact: true }) });
  await expect(models.getByText(baseline.model, { exact: true })).toBeVisible();
  await expect(models.getByText('off', { exact: true })).toBeVisible();
  await expect(app.getByText('remote backend — no llama.cpp devices', { exact: true })).toBeVisible();
  for (const endpoint of [origin, 'ws://127.0.0.1:18401/v1/ws', 'http://127.0.0.1:18402']) {
    await expect(app.getByText(endpoint, { exact: true })).toBeVisible();
  }
  await app.getByRole('button', { name: '重新发现端点', exact: true }).click();
  await expect(app.getByText('端点已重新发现，客户端已重连', { exact: true })).toBeVisible();
  await expect(health.getByText('ok', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: 'run maintenance', exact: true }).click();
  await expect(app.getByText(/total:.*errors:/)).toBeVisible({ timeout: 120_000 });
  await expect(app.getByText('none', { exact: true })).toBeVisible();
  await info.attach('live-service-health', { body: JSON.stringify(await (await fetch(origin + '/v1/health')).json(), null, 2), contentType: 'application/json' });
});

test('WANDER-002 记忆表单校验、创建、JSON 查看、搜索及取消和确认删除', async ({ app }, info) => {
  const marker = `验收库存编号 WM${Date.now()} 对应的唯一颜色为琥珀色`;
  await route(app, '/wander-memory/memories');
  await app.getByRole('button', { name: 'store memory', exact: true }).click();
  await expect(app.getByText("field 'memory' must be a non-empty string", { exact: true })).toBeVisible();
  await app.getByPlaceholder('memory text…', { exact: true }).fill(marker);
  await app.getByPlaceholder(/metadata \(optional/).fill('invalid metadata line');
  await app.getByRole('button', { name: 'store memory', exact: true }).click();
  await expect(app.getByText('metadata must be key=value lines (e.g. type=fact)', { exact: true })).toBeVisible();
  const item = await store(app, marker, 'type=fact\nsource=system');
  const card = app.locator('article', { hasText: marker });
  await card.getByTitle(`${item.id} — 点击复制`, { exact: true }).click();
  await expect.poll(async () => (await native({ action: 'clipboard' })).text).toBe(item.id);
  await card.getByRole('button', { name: /查看记忆/ }).click();
  const dialog = app.getByRole('dialog');
  const json = JSON.parse(await dialog.locator('pre').innerText());
  expect(JSON.stringify(json)).toContain(item.id);
  expect(json.memory.metadata.source).toBe('system');
  await info.attach('created-memory', { body: JSON.stringify(json, null, 2), contentType: 'application/json' });
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await app.getByPlaceholder(/search memories/).fill(marker);
  await app.getByPlaceholder('top_k', { exact: true }).fill('1');
  await app.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(app.locator('article')).toHaveCount(1);
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: /删除记忆/ }).click();
  await app.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
  expect((await records()).some(record => record.id === item.id)).toBe(true);
  await remove(app, marker);
});

test('WANDER-003 实际目录扫描、文件详情、自定义入库及磁盘变化刷新', async ({ app }, info) => {
  const id = `wander-files-${Date.now()}`;
  const directory = path.join(root, 'workspace', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'sample.txt'), `文档编号 ${id}\n这是用于真实文件扫描的文本。`, 'utf8');
  await route(app, '/wander-memory/files');
  await expect(app.getByText('fs api: ok', { exact: true })).toBeVisible();
  await expect(app.getByRole('button', { name: 'open', exact: true })).toBeDisabled();
  await app.getByPlaceholder('directory path…', { exact: true }).fill(directory);
  await app.getByRole('button', { name: 'open', exact: true }).click();
  await app.getByRole('button', { name: /sample\.txt/ }).click();
  await expect(app.getByRole('heading', { name: 'sample.txt', exact: true })).toBeVisible();
  const marker = `${id} 文件的自定义记忆为验收完成后归档`;
  await app.getByRole('textbox', { name: 'custom ingest', exact: true }).fill(marker);
  await app.getByRole('button', { name: 'store ingest', exact: true }).click();
  await expect(app.locator('article', { hasText: marker })).toBeVisible({ timeout: 120_000 });
  await app.getByRole('button', { name: 'load memories', exact: true }).click();
  await expect(app.locator('article', { hasText: marker })).toBeVisible();
  const matching = (await records()).filter(item => JSON.stringify(item).includes(marker));
  expect(matching).toHaveLength(1);
  expect(matching[0].metadata.path).toBe('sample.txt');
  await info.attach('file-linked-memory', { body: JSON.stringify(matching, null, 2), contentType: 'application/json' });
  writeFileSync(path.join(directory, 'after-scan.txt'), '目录刷新应发现这个后来添加的文件。', 'utf8');
  await app.getByRole('button', { name: 'reload', exact: true }).click();
  await expect(app.getByRole('button', { name: /after-scan\.txt/ })).toBeVisible();
  await remove(app, marker);
});

test('WANDER-004 真实对话提取、导入结果及库存持久化', async ({ app }, info) => {
  const marker = `云杉${Date.now()}`;
  await route(app, '/wander-memory/dialogue');
  const submit = app.getByRole('button', { name: 'import dialogue', exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(app.getByText("field 'dialogue' must be a non-empty string", { exact: true })).toBeVisible();
  await app.getByPlaceholder(/paste a transcript/).fill(JSON.stringify([
    { role: 'user', content: `我的验收项目代号是${marker}，项目的固定颜色是橙色。` },
    { role: 'assistant', content: '已记住项目代号和颜色。' },
  ]));
  await expect(app.getByText('✓ detected a JSON message array — will be sent verbatim', { exact: true })).toBeVisible();
  await submit.click();
  await expect(app.getByRole('heading', { name: /stored [1-9]\d* · total/ })).toBeVisible({ timeout: 120_000 });
  await expect(app.locator('article', { hasText: marker }).first()).toBeVisible();
  const stored = (await records()).filter(item => JSON.stringify(item).includes(marker));
  expect(stored.length).toBeGreaterThan(0);
  const diskFile = path.join(root, 'services', 'wander-data', 'users', 'default_user', 'textual_memory.json');
  const disk = JSON.parse(readFileSync(diskFile, 'utf8'));
  for (const item of stored) {
    const persisted = disk.find((entry: any) => entry.id === item.id);
    expect(persisted?.memory, 'Imported memories must also exist in the actual persistent store').toBe(item.memory);
  }
  await info.attach('memory-store-on-disk', { body: JSON.stringify(disk, null, 2), contentType: 'application/json' });
  await proveModel(marker, info);
  await route(app, '/wander-memory/memories');
  await app.getByPlaceholder(/search memories/).fill(marker);
  await app.getByRole('button', { name: '搜索', exact: true }).click();
  await expect(app.locator('article', { hasText: marker }).first()).toBeVisible();
  await info.attach('extracted-memories', { body: JSON.stringify(stored, null, 2), contentType: 'application/json' });
  // Each deletion is driven through the UI and limited to this case's facts.
  for (const item of stored) await remove(app, item.memory || item.text);
});

test('WANDER-005 基于真实库存的 DeepSeek 聊天、来源展示和清空', async ({ app }, info) => {
  const id = `WMCHAT${Date.now()}`;
  const answer = `琥珀${Math.floor(Math.random() * 900000 + 100000)}`;
  const seed = `验收项目 ${id} 的档案代号为 ${answer}。`;
  await store(app, seed);
  await route(app, '/wander-memory/chat');
  const clear = app.getByRole('button', { name: '清空对话', exact: true });
  if (await clear.isEnabled()) await clear.click();
  await expect(app.getByText('ws streaming', { exact: true })).toBeVisible();
  const query = `请查询验收项目 ${id} 的记忆并告诉我档案代号。`;
  await app.getByPlaceholder('type a message…', { exact: true }).fill(query);
  await app.getByRole('button', { name: '发送', exact: true }).click();
  await expect(app.getByText(query, { exact: true })).toBeVisible();
  const assistant = app.locator('[class*="assistantBubble"]').last();
  await expect(assistant.locator('p').first()).toContainText(answer, { timeout: 120_000 });
  await expect(assistant.getByText(/grounded on (?:[1-9]\d* memories|plain lexical recall)/)).toBeVisible();
  await expect(assistant).toContainText(seed);
  await proveModel(id, info);
  await clear.click();
  await expect(app.getByText(query, { exact: true })).toBeHidden();
  await expect(app.locator('[class*="assistantBubble"]')).toHaveCount(0);
  await remove(app, seed);
});

test('WANDER-006 上下文按条件检索、限制条数、实际内容与系统剪贴板', async ({ app }, info) => {
  const id = `WMCTX${Date.now()}`;
  const seed = `验收上下文 ${id} 的保留期限为三十六个月。`;
  await store(app, seed);
  await route(app, '/wander-memory/context');
  const build = app.getByRole('button', { name: 'build', exact: true });
  await expect(build).toBeDisabled();
  await app.getByPlaceholder('query…', { exact: true }).fill(id);
  await app.getByPlaceholder('top_k', { exact: true }).fill('1');
  await build.click();
  const result = app.locator('pre');
  await expect(result).toContainText(seed);
  const value = await result.innerText();
  await app.getByRole('button', { name: 'copy', exact: true }).click();
  await expect.poll(async () => (await native({ action: 'clipboard' })).text).toBe(value);
  const response = await fetch(origin + '/v1/context', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: id, top_k: 1 }) });
  expect(response.ok).toBe(true);
  const actual = await response.json();
  expect(actual.context).toBe(value);
  await info.attach('actual-context', { body: JSON.stringify(actual, null, 2), contentType: 'application/json' });
  await remove(app, seed);
});

test('WANDER-008 生成中按 Escape 取消界面等待并丢弃迟到结果', async ({ app }, info) => {
  const id = `WMCANCEL${Date.now()}`;
  const seed = `验收项目 ${id} 的主题是橙色风筝。`;
  await store(app, seed);
  await route(app, '/wander-memory/chat');
  const clear = app.getByRole('button', { name: '清空对话', exact: true });
  if (await clear.isEnabled()) await clear.click();
  const composer = app.locator('main input');
  const query = `查询 ${id} 的主题，并据此逐行写出编号 1 到 300 的不同描述，不要省略。`;
  await app.getByPlaceholder('type a message…', { exact: true }).fill(query);
  await app.getByPlaceholder('type a message…', { exact: true }).press('Enter');
  await expect(composer).toBeDisabled();
  const beforeKey = await app.evaluate(() => ({ activeTag: document.activeElement?.tagName, activeDisabled: (document.activeElement as HTMLInputElement)?.disabled }));
  await app.keyboard.press('Escape');
  const assistant = app.locator('[class*="assistantBubble"]').last();
  await expect.soft(assistant, 'The documented Escape action must display a client-side cancellation marker').toContainText('[cancelled]', { timeout: 3000 });
  await expect.soft(composer, 'Cancellation must release the composer while the server continues its own turn').toBeEnabled({ timeout: 3000 });
  await info.attach('escape-focus-state', { body: JSON.stringify(beforeKey), contentType: 'application/json' });
  // Server-side cancellation is explicitly unsupported. Wait for the actual
  // outstanding provider reads before clearing only this case's transcript.
  await proveModel(id, info);
  await expect.poll(() => {
    const events = calls();
    const requests = events.filter(e => e.event === 'request');
    return requests.length > 0 && requests.every(r => events.some(e => e.callId === r.callId && e.event === 'eof'));
  }, { timeout: 120_000 }).toBe(true);
  await expect(composer).toBeEnabled({ timeout: 120_000 });
  await expect.soft(assistant, 'A late server completion must not replace the cancelled bubble').toContainText('[cancelled]');
  await clear.click();
  await remove(app, seed);
});
