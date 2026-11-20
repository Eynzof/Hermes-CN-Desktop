import { expect, test } from "@playwright/test";

for (const action of ["answer", "follow-up"] as const) {
  test(`batch clarify: ${action} releases the original turn`, async ({ page }) => {
    await page.goto("/");
    const composer = page.getByRole("textbox", { name: "输入消息" });
    await composer.fill("clarify-batch-e2e");
    await page.getByRole("button", { name: "发送消息" }).click();
    const card = page.getByRole("form", { name: "补充信息" });
    await expect(card).toContainText("选择平台");
    const replies = page.getByRole("log").locator('[data-role="assistant"]');
    if (action === "follow-up") {
      await composer.fill("继续处理下一项");
      await page.getByRole("button", { name: "发送消息" }).click();
      await expect(replies.last()).toContainText("PONG: 收到「继续处理下一项」");
    } else {
      await card.getByRole("radio", { name: /Mac/ }).check();
      await card.getByRole("button", { name: "提交回答" }).click();
      await expect(card).toContainText("填写验收标记");
      await card.getByRole("textbox").fill("通过 K42");
      await card.getByRole("button", { name: "提交回答" }).click();
      await expect(replies.last()).toContainText("Clarify result:");
      await expect(replies.last()).toContainText("Mac");
      await expect(replies.last()).toContainText("通过 K42");
    }
    await expect(card).toHaveCount(0);
  });
}
