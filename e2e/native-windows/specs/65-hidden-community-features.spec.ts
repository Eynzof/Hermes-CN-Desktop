import { test, expect, route } from '../fixtures';

test('SHELL-006 隐藏 Wander Memory 及 Wanderminds 账号入口', async ({ app }, testInfo) => {
  await route(app, '/');
  await expect(app.getByRole('link', { name: /Wander 记忆/ })).toHaveCount(0);
  for (const path of ['memories', 'files', 'dialogue', 'chat', 'context', 'status', 'api']) {
    await app.evaluate(path => { location.hash = `#/wander-memory/${path}`; }, path);
    await expect.poll(() => new URL(app.url()).hash).toBe('#/memory');
    await expect(app.locator('[data-wander-memory]')).toHaveCount(0);
  }
  await app.keyboard.press('Control+k');
  const palette = app.getByRole('dialog');
  await palette.getByRole('combobox').fill('wander');
  await expect(palette.getByRole('option')).toHaveCount(0);
  await app.keyboard.press('Escape');
  for (const path of ['/models', '/connection', '/about']) {
    await route(app, path);
    await expect(app.getByRole('button', { name: /Wanderminds.*登录|登录.*Wanderminds/i })).toHaveCount(0);
    await expect(app.locator('a[href*="id.wanderminds"]')).toHaveCount(0);
  }
  await testInfo.attach('hidden-features-acceptance', { body: await app.screenshot(), contentType: 'image/png' });
});
