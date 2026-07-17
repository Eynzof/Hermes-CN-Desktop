import { expect, test } from "@playwright/test";

test("CLI custom endpoint appears and follows the runtime provider selection", async ({ page }) => {
  await page.route("**/api/config", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        model_context_length: 0,
        providers: {},
        custom_providers: [
          {
            name: "zijian",
            base_url: "https://example.test/anthropic",
            api_key: "test-key",
            api_mode: "anthropic_messages",
          },
        ],
      }),
    });
  });
  await page.route("**/api/model/info", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        model: "claude-opus-4-8",
        provider: "custom:zijian",
        auto_context_length: 1_000_000,
        config_context_length: 0,
        effective_context_length: 1_000_000,
      }),
    });
  });

  await page.goto("/models");

  await expect(page.getByText("当前模型:").locator("..")).toContainText(
    "claude-opus-4-8 (custom:zijian)",
  );
  await expect(page.getByText(/自定义 1 个/)).toBeVisible();

  const zijianCard = page.locator('[id="provider-custom:zijian"]');
  await expect(zijianCard).toBeVisible();
  await expect(zijianCard).toHaveAttribute("data-active", "true");
  await expect(zijianCard).toHaveAttribute("data-current", "true");
  await expect(zijianCard).toContainText("zijian");
  await expect(zijianCard).toContainText("Claude");
  await expect(zijianCard).toContainText("当前");

  await expect(page.locator("#provider-deepseek")).toHaveAttribute("data-active", "false");
});
