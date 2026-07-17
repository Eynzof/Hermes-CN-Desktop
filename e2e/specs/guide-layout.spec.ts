import { expect, test } from "@playwright/test";

test.describe("新手使用引导", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test("用小白能理解的场景说明两种开始方式", async ({ page }) => {
    await page.goto("/guide");

    await expect(page.getByRole("img", { name: "Hermes Agent 品牌 Logo" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "你想怎么开始使用 Hermes？" })).toBeVisible();
    await expect(page.getByText("不确定怎么选？直接选择“开箱即用”，适合绝大多数用户。")).toBeVisible();
    await expect(page.getByRole("button", { name: /开箱即用/ })).toContainText("第一次使用");
    await expect(page.getByRole("button", { name: /连接已有 Hermes/ })).toContainText("已经在本机另一套环境或服务器上运行 Hermes");

    for (const lifecycleAction of ["停止内核", "重装内核", "卸载内核", "快速配置模型", "健康检查"]) {
      await expect(page.getByText(lifecycleAction, { exact: false })).toHaveCount(0);
    }
  });

  test("选择开箱即用后自动准备桌面服务并直达模型页", async ({ page }) => {
    await page.addInitScript(() => {
      const calls: Array<{ name: string; payload?: unknown }> = [];
      Object.assign(window as unknown as Record<string, unknown>, {
        __guideCalls: calls,
        hermesDesktop: {
          applyConnectionConfig: async (payload: unknown) => {
            calls.push({ name: "applyConnectionConfig", payload });
            return { ok: true, mode: "managed" };
          },
          setGuideState: async (payload: unknown) => {
            calls.push({ name: "setGuideState", payload });
            return {
              ok: true,
              guideState: "completed",
              desiredState: "running",
              lifecycleState: "running",
              installed: true,
              running: true,
              backendReady: true,
            };
          },
        },
      });
    });

    await page.goto("/guide");
    await page.getByRole("button", { name: /选择开箱即用/ }).click();

    await expect(page).toHaveURL(/\/models$/);
    await expect(page.getByRole("main").getByText("模型", { exact: true }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(() => (
      window as unknown as { __guideCalls: Array<{ name: string; payload?: unknown }> }
    ).__guideCalls)).toEqual([
      { name: "applyConnectionConfig", payload: { mode: "managed" } },
      { name: "setGuideState", payload: "completed" },
    ]);
  });

  test("只有主动选择已有 Hermes 时才展开连接配置", async ({ page }) => {
    await page.addInitScript(() => {
      Object.assign(window as unknown as Record<string, unknown>, {
        hermesDesktop: {
          getConnectionConfig: async () => ({
            mode: "managed",
            localUrl: "http://127.0.0.1:9119",
            remoteUrl: "",
            remoteTokenSet: false,
            remoteAuthMode: "token",
            remoteSessionSet: false,
            envOverride: false,
            effectiveMode: "managed",
          }),
        },
      });
    });

    await page.goto("/guide");
    await expect(page.getByRole("heading", { name: "连接你已有的 Hermes" })).toHaveCount(0);

    await page.getByRole("button", { name: /填写已有 Hermes 的连接信息/ }).click();

    await expect(page.getByRole("heading", { name: "连接你已有的 Hermes" })).toBeVisible();
    await expect(page.getByRole("radio", { name: /本机其他 Hermes/ })).toBeVisible();
    await expect(page.getByRole("radio", { name: /远端服务器 Hermes/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "连接并进入桌面端" })).toBeVisible();
    await expect(page.getByText("卸载内核", { exact: false })).toHaveCount(0);
  });
});
