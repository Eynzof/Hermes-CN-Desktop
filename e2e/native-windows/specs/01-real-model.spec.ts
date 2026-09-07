import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, baseline, bridge, chat, root } from '../fixtures';

test('CHAT-001 已安装应用通过 DeepSeek 官方模型完成真实对话', async ({ app }, testInfo) => {
  const runtime = await bridge<any>(app, 'getRuntimeInfo');
  expect(runtime.current.runtimeVersion).toBe(baseline.runtimeVersion);
  expect(runtime.current.sourceCommit).toBe(baseline.coreCommit);
  expect(['bundled', 'update']).toContain(runtime.current.source);
  expect(runtime.current.artifactSha256).toBe(baseline.runtimeArchiveSha256);
  expect(runtime.mode).toBe('managed');
  const marker = `native-e2e-${Date.now()}`;
  const { evidence } = await chat(app, `这是桌面端真实模型端到端测试。请只原样回复下面这个标记，不调用任何工具：${marker}`, marker);
  expect(evidence.session.model).toBe(baseline.model);
  expect(evidence.session.billing_provider).toBe(baseline.provider);
  expect(evidence.session.billing_base_url.replace(/\/$/, '')).toBe(baseline.baseUrl);
  expect(evidence.session.input_tokens).toBeGreaterThan(0);
  expect(evidence.messages.some((m: any) => m.role === 'assistant' && m.content?.includes(marker))).toBe(true);
  await testInfo.attach('persisted-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await testInfo.attach('runtime-provenance', { body: JSON.stringify({ current: runtime.current, runtimeRoot: runtime.runtimeRoot }, null, 2), contentType: 'application/json' });
});

test('CHAT-002 真实模型调用本地工具写入并读取工作区文件', async ({ app }, testInfo) => {
  const marker = `tool-proof-${Date.now()}`;
  const file = path.join(root, 'workspace', `${marker}.txt`);
  const { evidence } = await chat(app,
    `请实际使用本地文件工具，在 ${file.replaceAll('\\', '/')} 新建一个 UTF-8 文本文件，内容只写 ${marker}。然后重新调用读取工具核对文件。完成后回复标记 ${marker}。这只操作专用测试文件。`, marker);
  expect(readFileSync(file, 'utf8').trim()).toBe(marker);
  expect(evidence.session.tool_call_count).toBeGreaterThan(0);
  expect(evidence.messages.some((m: any) => m.role === 'tool')).toBe(true);
  await testInfo.attach('persisted-tool-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});
