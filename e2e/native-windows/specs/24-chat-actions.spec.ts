import { test, expect, route, chat, native, api } from '../fixtures';

test('CHAT-008 消息复制、真实用量、推理展开及对话宽度持久化', async ({ app }, testInfo) => {
  await route(app, '/common');
  const reasoningRow = app.getByText('显示推理过程', { exact: true }).locator('..').locator('..');
  const original = await reasoningRow.locator('button[data-active="true"]').innerText();
  await reasoningRow.getByRole('button', { name: '显示', exact: true }).click();
  try {
    const marker = `copy-${Date.now()}`;
    const { id, evidence } = await chat(app, `先在思考中核算 123*17，最终仅回复 ${marker} 2091。`, `${marker} 2091`);
    const thinking = app.getByRole('log').getByRole('button', { name: /推理过程/ }).last();
    await thinking.click();
    await expect(thinking).toHaveAttribute('data-open', 'true');
    await expect(thinking.locator('..').locator('pre')).toContainText(/123|17|2091/);
    await thinking.click();
    await expect(thinking).toHaveAttribute('data-open', 'false');
    await app.getByRole('log').getByRole('button', { name: '复制', exact: true }).last().click();
    expect((await native({ action: 'clipboard' })).text).toContain(`${marker} 2091`);
    await app.getByRole('button', { name: '查看详细统计', exact: true }).last().click();
    const stats = app.getByRole('dialog');
    await expect(stats).toContainText('deepseek-v4-flash');
    await expect(stats).toContainText('输入');
    await expect(stats).toContainText('输出');
    expect(evidence.session.input_tokens).toBeGreaterThan(0);
    expect(evidence.session.output_tokens).toBeGreaterThan(0);
    await testInfo.attach('displayed-usage', { body: await stats.ariaSnapshot(), contentType: 'text/plain' });
    await app.getByRole('button', { name: '查看详细统计', exact: true }).last().click();
    const widths = app.getByRole('radiogroup', { name: '对话宽度', exact: true });
    for (const radio of await widths.getByRole('radio').all()) {
      await radio.click();
      await expect(radio).toHaveAttribute('aria-checked', 'true');
    }
    const last = await widths.getByRole('radio').last().getAttribute('data-width-value');
    await app.reload();
    await expect(widths.getByRole('radio').last()).toHaveAttribute('aria-checked', 'true');
    await widths.getByRole('radio').last().press('Home');
    await expect(widths.getByRole('radio').first()).toHaveAttribute('aria-checked', 'true');
    await widths.getByRole('radio').first().press('ArrowRight');
    await expect(widths.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await testInfo.attach('chat-actions-session', { body: JSON.stringify({ id, lastWidth: last, session: evidence.session }, null, 2), contentType: 'application/json' });
  } finally {
    await route(app, '/common');
    await reasoningRow.getByRole('button', { name: original, exact: true }).click();
  }
});
