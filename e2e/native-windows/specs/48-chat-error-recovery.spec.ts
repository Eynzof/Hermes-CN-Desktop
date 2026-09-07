import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, sendChat, sessionEvidence, deepseekKey, home } from '../fixtures';

test('CHAT-012 真实官方认证失败提示、原问题保留及修正凭证后重新发送', async ({ app }, testInfo) => {
  const marker = `auth-recovered-${Date.now()}`;
  const prompt = `不要使用工具，只回复 ${marker}。`;
  const saveKey = async (key: string) => {
    await route(app, '/models');
    await app.getByRole('tab', { name: /^主模型/ }).click();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    await app.getByRole('textbox', { name: 'DEEPSEEK_API_KEY', exact: true }).fill(key);
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(() => readFileSync(path.join(home, '.env'), 'utf8').includes(key)).toBe(true);
  };
  let corrected = false;
  try {
    await saveKey('e2e-intentionally-invalid-chat-key');
    await route(app, '/');
    await app.getByRole('textbox', { name: '输入消息', exact: true }).fill(prompt);
    await app.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(app).toHaveURL(/#\/tasks\//);
    const task = new URL(app.url()).hash.slice(1);
    await expect(app.getByRole('alert').filter({ hasText: '请求失败' })).toBeVisible({ timeout: 60_000 });
    await expect(app.getByRole('alert').filter({ hasText: '请求失败' })).toContainText(/401|Authentication|API.?key|认证/);
    await expect(app.getByRole('log').locator('[data-role="user"]').last()).toContainText(prompt);
    await testInfo.attach('real-authentication-failure', { body: await app.screenshot(), contentType: 'image/png' });
    const id = decodeURIComponent(task.split('/tasks/')[1]);
    const failed = sessionEvidence(id);
    expect(failed.log.some((line: string) => line.includes('tui turn finished:') && !line.includes('status=complete'))).toBe(true);
    await saveKey(deepseekKey());
    corrected = true;
    await route(app, task);
    // The UI has no dedicated retry button; resend the preserved question
    // through its ordinary composer after correcting the actual credential.
    const recovered = await sendChat(app, prompt, marker);
    expect(recovered.evidence.session.id).toBe(failed.session.id);
    expect(recovered.evidence.session.billing_provider).toBe('deepseek');
    expect(recovered.evidence.session.model).toBe('deepseek-v4-flash');
    await testInfo.attach('failed-and-recovered-real-turns', { body: JSON.stringify({ failed, recovered: recovered.evidence }, null, 2), contentType: 'application/json' });
  } finally {
    if (!corrected) await saveKey(deepseekKey());
  }
});
