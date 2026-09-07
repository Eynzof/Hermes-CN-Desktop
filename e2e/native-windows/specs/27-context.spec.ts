import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, chat, sendChat, root } from '../fixtures';

test('CHAT-011 会话草稿隔离、输入换行、手动压缩及压缩后真实续聊', async ({ app }, testInfo) => {
  const marker = `compact-${Date.now()}`;
  const first = await chat(app, `本会话需要保留的唯一验收暗号是 ${marker}。只回复 ACK，不要使用记忆工具。`, 'ACK');
  const taskRoute = new URL(app.url()).hash.slice(1);
  const input = app.getByRole('textbox', { name: '输入消息', exact: true });
  await input.fill('独立的会话草稿');
  await input.press('Shift+Enter');
  await input.press('End');
  await input.press('x');
  const draft = await input.inputValue();
  expect(draft).toContain('\n');
  await route(app, '/');
  await expect(input).not.toHaveValue(draft);
  await route(app, taskRoute);
  await expect(input).toHaveValue(draft);
  await app.reload();
  await expect(input).toHaveValue(draft);
  // A short history is an explicit no-op; the command must not be sent as a
  // normal user message or silently start a new model conversation.
  await input.fill('/compress');
  await app.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(app.getByRole('log')).toContainText('上下文无需压缩', { timeout: 90_000 });
  // v0.21 keeps user requests verbatim inside the summary. Bulky user input
  // therefore cannot demonstrate compaction savings; use real tool output.
  for (let turn = 0; turn < 7; turn++) {
    const file = path.join(root, 'workspace', `${marker}-${turn}.txt`);
    const tail = `FILE-END-${turn}`;
    writeFileSync(file, Array.from({ length: 190 }, (_, line) => `${line}: ${'red green blue orange sample data '.repeat(10)}`).join('\n') + `\n${tail}\n`);
    const result = await sendChat(app, `请调用文件读取工具，一次读取 ${file.replaceAll('\\', '/')} 的第 1 至 191 行。内容是可概括的测试资料，最后仅回复文件末尾的 FILE-END 标记。`, tail);
    expect(result.evidence.messages.filter((message: any) => message.role === 'tool').some((message: any) => message.content?.includes(tail) && message.content.length > 30_000)).toBe(true);
  }
  await input.fill('/compress 保留验收暗号');
  await app.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(app.getByRole('log')).toContainText('已压缩上下文', { timeout: 90_000 });
  await app.getByRole('button', { name: '上下文窗口', exact: true }).click();
  await expect(app.getByRole('dialog', { name: '上下文窗口', exact: true })).toContainText(/已压缩 [1-9]\d* 次/);
  await app.getByRole('button', { name: '上下文窗口', exact: true }).click();
  const after = await sendChat(app, '最初要求你保留的验收暗号是什么？仅回复暗号，不要使用工具。', marker);
  expect(after.evidence.session.output_tokens).toBeGreaterThan(0);
  await testInfo.attach('compression-lineage', { body: JSON.stringify({ original: first.evidence.session, after: after.evidence }, null, 2), contentType: 'application/json' });
});
