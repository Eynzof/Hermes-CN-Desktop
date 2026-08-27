import { expect, test } from "@playwright/test";

// End-to-end coverage for the button events that the chat-loop suite does not
// exercise: the Config page (renders the config editor surface) and the Logs
// page (filter segments + refresh). These run against the real Core dashboard
// served by the e2e harness, exactly like guide-layout.spec.ts /
// voice-settings.spec.ts. In web mode the TS runtime serves /api/config/schema
// in-process (no network request), so the harness's minimal config.yaml yields
// an empty schema — the config page renders its editor shell with an empty
// tablist, while the Logs page exposes real filter/refresh buttons to drive.
test.describe("Config & Logs workflows", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    // The harness backend has no model configured, so the first-run onboarding
    // dialog appears over every page. Pre-mark it dismissed (same key the dialog
    // reads from sessionStorage) so the pages are reachable.
    await page.addInitScript(() => {
      window.sessionStorage.setItem("hermes:model-onboarding-dismissed", "1");
    });
  });

  test("config page renders the config editor surface", async ({ page }) => {
    await page.goto("/config");
    await expect(page.getByText(/Hermes Agent 全部 .* 个配置项/)).toBeVisible();
    await expect(page.getByPlaceholder("搜索配置项…")).toBeVisible();
    // The empty schema still renders the 配置分类 tablist; with a real config it
    // holds the category tab buttons (常规 / Agent / 记忆 …).
    await expect(page.getByRole("tablist", { name: "配置分类" })).toBeVisible();
  });

  test("logs page filters by file / level / component and refreshes", async ({ page }) => {
    await page.goto("/logs");
    // Log filter segments use Chinese labels: 文件=智能体/错误/网关,
    // 级别=全部/Debug/Info/Warn/Error, 来源=全部/网关/智能体/工具/CLI/Cron.
    const agentFile = page.getByRole("button", { name: "智能体", exact: true }).first();
    await expect(agentFile).toBeVisible();

    const debugLevel = page.getByRole("button", { name: "Debug", exact: true }).first();
    await debugLevel.click();
    await expect(debugLevel).toHaveAttribute("data-active", "true");

    const gatewaySource = page.getByRole("button", { name: "网关", exact: true }).last();
    await gatewaySource.click();
    await expect(gatewaySource).toHaveAttribute("data-active", "true");

    // 刷新 button re-reads the log file from the backend.
    const refresh = page.getByRole("button", { name: /^刷新$/ }).first();
    await expect(refresh).toBeVisible();
    await refresh.click();
    await expect(refresh).toBeEnabled();
  });
});
