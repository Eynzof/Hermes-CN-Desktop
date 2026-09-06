import { test, expect } from "@playwright/test";
import { resolve } from "node:path";
import { DASHBOARD_ORIGIN, DASHBOARD_TOKEN, E2E_DIR, VENV_PY } from "../harness/config.mjs";

const headers = { "X-Hermes-Session-Token": DASHBOARD_TOKEN };

test("运行中的真实子任务可追加指令并停止", async ({ page }) => {
  const events: string[] = [];
  page.on("websocket", (ws) => ws.on("framereceived", ({ payload }) => events.push(String(payload))));
  await page.goto("/");
  await page.getByRole("textbox", { name: "输入消息" }).fill("v090-subagent-control");
  await page.getByRole("button", { name: "发送消息" }).click();
  await expect(page).toHaveURL(/\/tasks\/.+/);
  await page.getByRole("button", { name: "子Agent 监视", exact: true }).click();
  await page.getByRole("button", { name: "追加指令", exact: true }).click();
  await page.getByRole("textbox", { name: "子任务追加指令" }).fill("补充：只处理当前测试数据。");
  await page.getByRole("button", { name: "发送指令", exact: true }).click();
  await expect(page.getByText("指令已排队，将在下一个执行步骤读取。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "停止子任务", exact: true }).click();
  await expect.poll(() => events.some((frame) => frame.includes('"subagent.complete"') && frame.includes('"interrupted"')), { timeout: 30_000 }).toBe(true);
  await expect(page.getByRole("button", { name: "追加指令", exact: true })).toHaveCount(0);
});

test("定时任务编辑保留运行记忆并可清除网页监控", async ({ page, request }) => {
  const name = `v090-cron-${Date.now()}`;
  let jobId = "";
  try {
    await page.goto("/cron");
    await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await page.getByLabel("名称（可选）").fill(name);
    await page.getByLabel("调度表达式").fill("every 12h");
    await page.getByLabel("Prompt", { exact: true }).fill("发现网页变化后汇报差异。");
    await page.getByLabel("运行记忆", { exact: true }).selectOption("on");
    await page.getByLabel("监控网页（可选）").fill("https://example.com/updates");
    await page.getByRole("button", { name: "创建任务", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const jobs = await (await request.get(`${DASHBOARD_ORIGIN}/api/cron/jobs`, { headers })).json();
    const created = jobs.find((job: { name: string }) => job.name === name);
    expect(created.context_from).toEqual(["self"]);
    expect(created.monitor_url).toBe("https://example.com/updates");
    jobId = created.id;
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await expect(page.getByLabel("运行记忆", { exact: true })).toHaveValue("on");
    await page.getByLabel("Prompt", { exact: true }).fill("只汇报新变化，避免重复。");
    await page.getByLabel("运行记忆", { exact: true }).selectOption("off");
    await page.getByLabel("监控网页（可选）").fill("");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    const saved = (await (await request.get(`${DASHBOARD_ORIGIN}/api/cron/jobs`, { headers })).json()).find((job: { id: string }) => job.id === jobId);
    expect(saved.prompt).toBe("只汇报新变化，避免重复。");
    expect(saved.context_from ?? []).toEqual([]);
    expect(saved.monitor_url).toBeNull();
    expect(saved.schedule).toEqual(created.schedule);
  } finally {
    if (jobId) await request.delete(`${DASHBOARD_ORIGIN}/api/cron/jobs/${jobId}`, { headers });
  }
});

test("MCP 2 服务可连接并列出真实工具", async ({ page, request }) => {
  const name = `v090-mcp-${Date.now()}`;
  const added = await request.post(`${DASHBOARD_ORIGIN}/api/mcp/servers`, {
    headers, data: { name, command: VENV_PY, args: [resolve(E2E_DIR, "fixtures/mcp_echo.py")] },
  });
  expect(added.ok(), await added.text()).toBeTruthy();
  try {
    await page.goto("/mcp");
    await expect(page.getByText(name, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(page.getByText("echo", { exact: true })).toBeVisible();
  } finally {
    await request.delete(`${DASHBOARD_ORIGIN}/api/mcp/servers/${name}`, { headers });
  }
});
