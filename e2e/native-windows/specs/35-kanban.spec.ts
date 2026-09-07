import { chromium } from '@playwright/test';
import { test, expect, route, native, api } from '../fixtures';

test('KANBAN-001 系统浏览器入口、真实看板卡片增改、状态迁移和删除', async ({ app }, testInfo) => {
  await route(app, '/kanban');
  await app.getByRole('button', { name: '复制地址', exact: true }).click();
  const url = (await native({ action: 'clipboard' })).text;
  expect(url).toBe('http://localhost:9120/kanban');
  await app.getByRole('button', { name: '打开官方看板', exact: true }).click();
  let external: any;
  await expect.poll(async () => {
    external = (await native({ action: 'systemWindows' })).windows.find((w: any) => w.type === 'Chrome_WidgetWin_1' && w.text === 'Hermes Agent - Dashboard - Google Chrome');
    return Boolean(external);
  }).toBe(true);
  await native({ action: 'externalKeys', window: external.text, windowClass: external.type, windowHandle: external.handle, keys: '^l^c{ESC}' });
  expect((await native({ action: 'clipboard' })).text).toBe(url);
  // This separately launched installed Chrome has an isolated test profile.
  // The entry above proves the OS opener; CRUD below uses the same real Core
  // Dashboard with its actual session authentication and database.
  const browser = await chromium.connectOverCDP('http://127.0.0.1:19230');
  const page = browser.contexts()[0].pages()[0];
  const prompts: string[] = [];
  page.on('dialog', async dialog => {
    prompts.push(dialog.message());
    if (dialog.type() === 'prompt') await dialog.accept('E2E card workflow verified; no worker execution requested.');
    else await dialog.dismiss();
  });
  let id = '';
  const name = `kanban-${Date.now()}`;
  try {
    await page.goto(url);
    await expect(page.getByRole('textbox', { name: 'Filter cards…', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '+', exact: true }).nth(3).click();
    await page.getByRole('textbox', { name: 'New task title…', exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const card = page.locator('[data-task-id]').filter({ hasText: name });
    await expect(card).toHaveCount(1);
    id = (await card.getAttribute('data-task-id'))!;
    await card.click();
    const drawer = page.locator('.hermes-kanban-drawer');
    await expect(drawer.locator('.hermes-kanban-drawer-title-text')).toHaveText(name);
    await drawer.locator('.hermes-kanban-drawer-title-text').click();
    await drawer.locator('.hermes-kanban-drawer-title input').fill(name + '-edited');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await drawer.getByRole('button', { name: 'edit', exact: true }).click();
    await drawer.locator('.hermes-kanban-textarea').fill('Only a local E2E card. No worker or external messages requested.');
    await drawer.getByRole('button', { name: 'Save', exact: true }).click();
    await drawer.getByRole('textbox', { name: 'Add a comment… (Enter to submit)', exact: true }).fill('COMMENT-' + name);
    await drawer.getByRole('button', { name: 'Comment', exact: true }).click();
    await expect(drawer).toContainText('COMMENT-' + name);
    const read = () => api(app, `/api/plugins/kanban/tasks/${id}?board=default`);
    for (const [button, status] of [['Block', 'blocked'], ['Unblock', 'ready'], ['Complete', 'done']]) {
      await drawer.getByRole('button', { name: button, exact: true }).click();
      if (button !== 'Unblock') await page.getByRole('alertdialog').getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect.poll(async () => (await read()).task.status).toBe(status);
    }
    const evidence = await read();
    expect(evidence.task.title).toBe(name + '-edited');
    expect(prompts).toHaveLength(1);
    await testInfo.attach('kanban-persisted-task', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await drawer.getByRole('button', { name: '×', exact: true }).click();
    await page.getByRole('textbox', { name: 'Filter cards…', exact: true }).fill(name + '-missing');
    await expect(page.locator(`[data-task-id="${id}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    await page.getByRole('checkbox', { name: `Select task ${id}`, exact: true }).check();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.locator(`[data-task-id="${id}"]`)).toHaveCount(1);
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.locator(`[data-task-id="${id}"]`)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Filter cards…', exact: true })).toBeVisible();
    await expect(page.locator(`[data-task-id="${id}"]`)).toHaveCount(0);
  } finally {
    await testInfo.attach('real-dashboard', { body: await page.screenshot(), contentType: 'image/png' });
    await testInfo.attach('dashboard-accessibility', { body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain' });
    await page.goto('about:blank');
    await browser.close();
  }
});
