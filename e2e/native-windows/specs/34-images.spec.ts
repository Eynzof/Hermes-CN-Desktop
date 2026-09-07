import path from 'node:path';
import { existsSync } from 'node:fs';
import { test, expect, route, sendChat, native, nativeDialog } from '../fixtures';

test('CHAT-007 原生图片附件、剪贴板图片、移除及纯文本模型能力反馈', async ({ app }, testInfo) => {
  const picture = await native({ action: 'clipboardImage' });
  expect(existsSync(picture.path)).toBe(true);
  await route(app, '/');
  await app.getByRole('button', { name: '添加附件', exact: true }).click();
  await nativeDialog('选择附件', path.normalize(picture.path), '%o');
  await expect(app.locator('[data-kind="image"][data-status="ready"]')).toHaveCount(1);
  await app.getByRole('button', { name: `移除 ${path.basename(picture.path)}`, exact: true }).click();
  await expect(app.locator('[data-kind="image"][data-status="ready"]')).toHaveCount(0);
  // The native filename entry itself uses the text clipboard. Restore actual
  // image bytes before testing the separate clipboard-image entry point.
  await native({ action: 'clipboardImage' });
  await app.getByRole('button', { name: '添加剪贴板图片', exact: true }).click();
  const pasted = app.locator('[data-kind="image"][data-status="ready"]');
  await expect(pasted).toHaveCount(1);
  await expect(pasted.locator('img')).toBeVisible();
  const dimensions = await pasted.locator('img').evaluate((image: HTMLImageElement) => ({ width: image.naturalWidth, height: image.naturalHeight }));
  expect(dimensions).toEqual({ width: 96, height: 64 });
  await testInfo.attach('clipboard-preview', { body: await app.screenshot(), contentType: 'image/png' });
  const result = await sendChat(app, '请如实说明你是否可以直接理解附图。不要使用终端、OCR、文件工具或其他模型。如果当前仅收到文件路径、没有图片像素输入，只回复 CANNOT-SEE-IMAGE；不要猜测内容。', 'CANNOT-SEE-IMAGE');
  expect(result.evidence.session.model).toBe('deepseek-v4-flash');
  expect(result.evidence.session.billing_provider).toBe('deepseek');
  expect(result.evidence.session.tool_call_count).toBe(0);
  expect(result.evidence.messages.some((m: any) => m.role === 'user' && /\.png/.test(m.content))).toBe(true);
  await expect(app.getByRole('log').locator('img').filter({ hasNot: app.locator('[src=""]') }).first()).toBeVisible();
  await expect(app.locator('[data-kind="image"][data-status="ready"]')).toHaveCount(0);
  await testInfo.attach('image-session', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
});
