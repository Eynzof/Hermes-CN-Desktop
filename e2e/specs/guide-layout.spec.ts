import { expect, test } from "@playwright/test";

test.describe("使用引导布局", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("展示正式 Logo 并可滚动到完成操作", async ({ page }) => {
    await page.goto("/guide");

    const logo = page.getByRole("img", { name: "Hermes Agent 品牌 Logo" });
    await expect(logo).toBeVisible();
    await expect(logo.locator("path")).toHaveCount(1);

    const guide = page.getByTestId("guide-scroll-container");
    await expect(guide).toBeVisible();

    const initial = await guide.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    }));
    expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
    expect(initial.scrollTop).toBe(0);

    await guide.hover();
    await page.mouse.wheel(0, 900);
    await expect.poll(() => guide.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

    await guide.evaluate((element) => element.scrollTo({ top: element.scrollHeight, behavior: "auto" }));
    await expect(page.getByRole("button", { name: /完成引导并进入工作台/ })).toBeInViewport();

    const remainingDistance = await guide.evaluate(
      (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
    );
    expect(remainingDistance).toBeLessThanOrEqual(1);
  });
});
