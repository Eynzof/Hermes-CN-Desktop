import { test, expect, type Page } from "@playwright/test";

// Real MemOS (WanderMemory) surface driven through the real UI, against the
// real Core backend (start-backend.mjs) AND the real MemOS backend. Two
// modes:
//   • default: start-memos.mjs spawns MemOS with WanderMemory's own
//     DummyOpenAIBackend as the remote LLM (deterministic echo).
//   • MEMOS_REUSE_EXISTING=1: an externally running MemOS backend serves the
//     default 18400 trio — the REAL local model via llama.cpp (Qwen3.5-4B).
//     Assertions then check behavior (a real reply arrived / status ok /
//     CUDA device listed), never LLM wording.
//
// Every frontend button in the /wander-memory surface is exercised:
//   memories: store memory, 搜索, view JSON, 删除记忆 (dialog confirm)
//   chat:     发送 (streaming), 清空对话
//   dialogue: import dialogue (real LLM extraction)
//   context:  build + copy
//   files:    scan directory
//   status:   run maintenance, 重新发现端点

const openWanderTab = async (page: Page) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByText("Wander 记忆").click();
  await expect(page).toHaveURL(/\/wander-memory\/memories/);
};

const wanderSidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Wander 记忆侧栏" });

test("wander-memory: add → view → search → delete a memory against the real MemOS", async ({ page }) => {
  await openWanderTab(page);

  // ── add a memory with a unique marker ────────────────────────────────────
  const marker = `测试记忆 ${Date.now()}`;
  await page.getByPlaceholder("memory text…").fill(marker);
  await page.getByRole("button", { name: "store memory" }).click();
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });

  // ── view JSON dialog ─────────────────────────────────────────────────────
  const card = page.locator("article", { hasText: marker }).first();
  await card.getByRole("button", { name: /查看记忆/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText(marker)).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toBeHidden({ timeout: 10_000 });

  // ── search for the marker ────────────────────────────────────────────────
  await page.getByPlaceholder(/search memories/).fill(marker);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 30_000 });

  // ── delete it and verify removal ─────────────────────────────────────────
  const card2 = page.locator("article", { hasText: marker }).first();
  await card2.getByRole("button", { name: /删除记忆/ }).click();
  const deleteDialog = page.getByRole("dialog");
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText(marker)).toHaveCount(0, { timeout: 30_000 });
});

test("wander-memory: chat streams a reply through the real MemOS WS", async ({ page }) => {
  await openWanderTab(page);

  // Seed a memory so the grounded reply has something to find (the real
  // backend cancels generation when nothing matches — empty reply).
  const seed = `用户喜欢喝茶 ${Date.now()}`;
  await page.getByPlaceholder("memory text…").fill(seed);
  await page.getByRole("button", { name: "store memory" }).click();
  await expect(page.getByText(seed).first()).toBeVisible({ timeout: 30_000 });

  await wanderSidebar(page).getByRole("link", { name: /聊天/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/chat/);

  const composer = page.getByPlaceholder("type a message…");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const query = `我喜欢喝什么 ${Date.now()}`;
  await composer.fill(query);
  await page.getByRole("button", { name: "发送" }).click();

  // The user turn lands in the transcript...
  await expect(page.getByText(query, { exact: true })).toBeVisible({ timeout: 15_000 });
  // ...and the assistant bubble fills with a real grounded reply (streamed
  // over WS). The seeded memory must appear in the grounding trace.
  const assistant = page.locator("[class*='assistantBubble']").first();
  await expect(assistant).toBeVisible({ timeout: 30_000 });
  await expect(assistant.locator("p").first()).not.toBeEmpty({ timeout: 60_000 });
  // The grounding trace must reference the seeded memory (proves the real
  // recall + reply path ran — not the no-grounding cancel fallback).
  await expect(assistant.getByText(/grounded on [1-9]\d* memories/)).toBeVisible({
    timeout: 60_000,
  });

  // ── 清空对话 button ──────────────────────────────────────────────────────
  await page.getByRole("button", { name: "清空对话" }).click();
  await expect(page.getByText(query, { exact: true })).toHaveCount(0, { timeout: 10_000 });
});

test("wander-memory: status shows a healthy MemOS on the default 18400 trio", async ({ page }) => {
  await openWanderTab(page);
  await wanderSidebar(page).getByRole("link", { name: /状态/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/status/);

  // health card: status ok + a model is configured
  const healthCard = page
    .locator("section", { has: page.getByRole("heading", { name: "health" }) })
    .first();
  await expect(healthCard.getByText("ok", { exact: true })).toBeVisible({ timeout: 30_000 });
  const modelRow = healthCard.locator("dl > div", { hasText: "model" }).first();
  await expect(modelRow).toContainText(/Qwen3.5-4B|dummy/, { timeout: 30_000 });

  // models card: reasoning off
  const modelsCard = page
    .locator("section", { has: page.getByRole("heading", { name: "models" }) })
    .first();
  await expect(modelsCard.getByText("off", { exact: true })).toBeVisible({ timeout: 30_000 });

  // backends card: the real local llama.cpp backend lists the CUDA device.
  const backendsCard = page
    .locator("section", { has: page.getByRole("heading", { name: "backends" }) })
    .first();
  await expect(backendsCard.getByText("cuda", { exact: true })).toBeVisible({ timeout: 30_000 });

  // endpoint display resolves to the default trio (env/ui-store empty in the
  // fresh browser context → defaults).
  const endpointSection = page
    .locator("section", { has: page.getByRole("heading", { name: "endpoint settings" }) })
    .first();
  await expect(endpointSection.getByText("http://127.0.0.1:18400", { exact: true })).toBeVisible(
    { timeout: 30_000 },
  );
  await expect(endpointSection.getByText("ws://127.0.0.1:18401/v1/ws", { exact: true })).toBeVisible();

  // ── 重新发现端点 button (rediscovery) ────────────────────────────────────
  await page.getByRole("button", { name: "重新发现端点" }).click();
  await expect(page.getByText("端点已重新发现，客户端已重连")).toBeVisible({ timeout: 30_000 });
  // After rediscovery the health card still shows ok.
  await expect(healthCard.getByText("ok", { exact: true })).toBeVisible({ timeout: 30_000 });

  // ── run maintenance button ───────────────────────────────────────────────
  await page.getByRole("button", { name: "run maintenance" }).click();
  await expect(page.getByText(/total:/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("none", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("wander-memory: dialogue import extracts memories with the real LLM", async ({ page }) => {
  await openWanderTab(page);
  await wanderSidebar(page).getByRole("link", { name: /对话导入/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/dialogue/);

  const marker = `豆豆${Date.now()}`;
  await page
    .getByPlaceholder(/paste a transcript/)
    .fill(`user: 我养了一只叫${marker}的猫\nassistant: 好的，我记住了。`);
  await page.getByRole("button", { name: "import dialogue" }).click();

  // Extraction + collision pipeline — real LLM call, generous window.
  await expect(page.getByText(/stored \d+/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(marker, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
});

test("wander-memory: context preview builds + copies", async ({ page }) => {
  await openWanderTab(page);

  // Seed a memory so the context build has something to render.
  const seed = `用户常喝龙井茶 ${Date.now()}`;
  await page.getByPlaceholder("memory text…").fill(seed);
  await page.getByRole("button", { name: "store memory" }).click();
  await expect(page.getByText(seed).first()).toBeVisible({ timeout: 30_000 });

  await wanderSidebar(page).getByRole("link", { name: /上下文/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/context/);

  await page.getByPlaceholder("query…").fill("茶");
  await page.getByRole("button", { name: "build", exact: true }).click();
  const contextBlock = page.locator("pre").first();
  await expect(contextBlock).toBeVisible({ timeout: 30_000 });
  await expect(contextBlock).not.toBeEmpty();

  // copy button (clipboard permissions granted by the browser context)
  await page.getByRole("button", { name: /copy/ }).click();
  await expect(page.getByText("已复制")).toBeVisible({ timeout: 10_000 });
});

test("wander-memory: files scan button works against the FS API", async ({ page }) => {
  await openWanderTab(page);
  await wanderSidebar(page).getByRole("link", { name: /文件/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/files/);

  // The files page probes FS health on mount; the status line shows it when up.
  const dirInput = page.getByPlaceholder("directory path…");
  await expect(dirInput).toBeVisible({ timeout: 15_000 });
  await dirInput.fill("D:/WanderMemory/docs");
  await page.getByRole("button", { name: "open", exact: true }).click();

  // Scan result: the docs directory contains .md files.
  await expect(page.getByText(/memory_api\.md|mem_filesys\.md/).first()).toBeVisible({ timeout: 30_000 });
});
