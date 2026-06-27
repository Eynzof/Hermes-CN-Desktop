import { test, expect } from "@playwright/test";
import { PNG_BASE64, PNG_BYTE_LENGTH } from "../fixtures/red-square.mjs";

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
  const lastAssistant = page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant).toContainText("我看到一张图片", { timeout: 30_000 });
  // The exact decoded byte count proves the real image bytes reached the model.
  await expect(lastAssistant).toContainText(String(PNG_BYTE_LENGTH));
});
