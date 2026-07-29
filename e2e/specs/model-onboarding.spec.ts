import { expect, test, type Page } from "@playwright/test";

async function mockUnconfiguredModel(page: Page) {
  await page.route("**/api/model/info", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      json: {
        model: "",
        provider: "",
        effective_context_length: 0,
      },
    });
  });
}

test.describe("首次模型引导 Modal", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("在真实工作台上提供配置模型和先看看界面两条主路径", async ({ page }) => {
    await mockUnconfiguredModel(page);
    await page.goto("/");

    const dialog = page.getByRole("dialog", { name: "开始使用 Hermes" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("button", { name: "配置模型" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "先看看界面" })).toBeVisible();
    await expect(dialog.getByText("已经有自己的 Hermes 内核？")).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(700);

    await dialog.getByRole("button", { name: "先看看界面" }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();

    await page.reload();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "输入消息" })).toBeVisible();
  });

  test("配置模型会直达推荐服务商，连接自己的内核会进入连接页", async ({ page }) => {
    await mockUnconfiguredModel(page);
    await page.goto("/");

    const dialog = page.getByRole("dialog", { name: "开始使用 Hermes" });
    await dialog.getByRole("button", { name: "配置模型" }).click();
    await expect(page).toHaveURL(/\/models#provider-deepseek$/);
    await expect(dialog).toHaveCount(0);

    await page.goto("/");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "连接自己的内核" }).click();
    await expect(page).toHaveURL(/\/connection$/);
    await expect(dialog).toHaveCount(0);
  });
});
