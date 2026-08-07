import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PNG_BASE64, PNG_BYTE_LENGTH } from "../fixtures/red-square.mjs";
import { HERMES_HOME } from "../harness/config.mjs";

// The image closed loop: paste an image into the composer, send, and assert the
// model "read" it. This drives the real production path — the composer sends the
// pasted image's bytes over the gateway via image.attach_bytes (no REST upload),
// exactly as shipped. The fake model echoes the DECODED image byte count, so a
// passing assertion proves the bytes traversed UI -> gateway -> provider -> model.

test("paste an image → it attaches → the model reads it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();

  // Synthesize a real clipboard paste of a PNG into the composer textarea.
  await page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const dt = new DataTransfer();
    dt.items.add(new File([blob], "shot.png", { type: "image/png" }));
    const ta = document.querySelector('textarea[aria-label="输入消息"]');
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    // Chromium ignores the clipboardData init option; attach it explicitly.
    Object.defineProperty(event, "clipboardData", { value: dt });
    ta?.dispatchEvent(event);
  }, PNG_BASE64);

  // The pasted image shows up as a ready attachment chip.
  await expect(
    page.locator('span[data-kind="image"][data-status="ready"]'),
  ).toBeVisible({ timeout: 10_000 });

  // Ask about the image and send.
  await page.getByRole("textbox", { name: "输入消息" }).fill("图里是什么？");
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
  const lastUser = page.getByRole("log").locator('[data-role="user"]').last();
  await expect(lastUser.getByRole("img", { name: "shot.png" })).toBeVisible({ timeout: 10_000 });
  await expect(lastUser).not.toContainText("图片暂不能直接预览");

  const lastAssistant = page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant).toContainText("我看到一张图片", { timeout: 30_000 });
  // The exact decoded byte count proves the real image bytes reached the model.
  await expect(lastAssistant).toContainText(String(PNG_BYTE_LENGTH));
});

test("paste a PDF → it stays a file attachment, not a PNG preview", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();

  await page.evaluate(async () => {
    const dt = new DataTransfer();
    dt.items.add(new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"], "report.pdf", { type: "application/pdf" }));
    const ta = document.querySelector('textarea[aria-label="输入消息"]');
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: dt });
    ta?.dispatchEvent(event);
  });

  await expect(
    page.locator('span[data-kind="file"][data-status="ready"]'),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("textbox", { name: "输入消息" }).fill("总结这个 PDF");
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
  const lastUser = page.getByRole("log").locator('[data-role="user"]').last();
  await expect(lastUser).toContainText("附件：report.pdf", { timeout: 10_000 });
  await expect(lastUser.getByRole("img", { name: /report\.pdf/i })).toHaveCount(0);
  await expect(lastUser).not.toContainText("clipboard-");
});

test("assistant Markdown image with a local path is previewable", async ({ page }) => {
  const imageDir = join(HERMES_HOME, "images", "generated previews");
  const imagePath = join(imageDir, "model output.png");
  mkdirSync(imageDir, { recursive: true });
  writeFileSync(imagePath, Buffer.from(PNG_BASE64, "base64"));

  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
  await page.getByRole("textbox", { name: "输入消息" }).fill(`return-image-e2e:${imagePath}`);
  await page.getByRole("button", { name: "发送消息" }).click();

  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
  const lastAssistant = page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant).toContainText("模型生成图片", { timeout: 30_000 });
  await expect(lastAssistant.getByRole("img", { name: "生成图" })).toBeVisible({ timeout: 10_000 });
  await expect(lastAssistant).not.toContainText("图片暂不能直接预览");
});
