import { expect, test } from "@playwright/test";

test("健康检查与 MCP 页面使用同一个官方服务列表接口", async ({ page }) => {
  const requestedApiPaths: string[] = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/api/")) requestedApiPaths.push(path);
  });

  await page.goto("/health");

  const mcpCard = page.locator('[data-health-item="mcp"]');
  await expect(mcpCard).toContainText("0 / 0");
  await expect(mcpCard).toContainText("未配置");

  expect(requestedApiPaths).toContain("/api/mcp/servers");
  expect(requestedApiPaths).not.toContain("/api/mcp-servers");
});
