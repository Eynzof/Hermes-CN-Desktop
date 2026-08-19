import { test, expect, type Page } from "@playwright/test";

// Real MemOS (WanderMemory) surface driven through the real UI, against the
// real Core backend (start-backend.mjs) AND the real MemOS backend
// (start-memos.mjs: python -m src.memory --remote <cfg> with WanderMemory's
// own DummyOpenAIBackend as the LLM). Deterministic end to end:
//   memories: add (collision pipeline via the dummy LLM) → search → delete
//   chat:     streaming reply over the real /v1/ws (REST fallback otherwise)
//   status:   health card ok + endpoint display on the default 18400 trio
//
// The dummy responder echoes "你好，我是远程记忆助手。你说的是：" + the query,
// so assertions check behavior (a real reply arrived), not LLM wording.

const openWanderTab = async (page: Page) => {
  await page.goto("/");
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByText("Wander 记忆").click();
  await expect(page).toHaveURL(/\/wander-memory\/memories/);
};

const wanderSidebar = (page: Page) =>
  page.getByRole("complementary", { name: "Wander 记忆侧栏" });

test("wander-memory: add → search → delete a memory against the real MemOS", async ({ page }) => {
  await openWanderTab(page);

  // ── add a memory with a unique marker ────────────────────────────────────
  const marker = `测试记忆 ${Date.now()}`;
  await page.getByPlaceholder("memory text…").fill(marker);
  await page.getByRole("button", { name: "store memory" }).click();
  // The add path runs the real collision pipeline (one dummy-LLM call), then
  // the list refetches — give it a generous window.
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 25_000 });

  // ── search for the marker ────────────────────────────────────────────────
  await page.getByPlaceholder(/search memories/).fill(marker);
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByText(marker).first()).toBeVisible({ timeout: 25_000 });

  // ── delete it and verify removal ─────────────────────────────────────────
  const card = page.locator("article", { hasText: marker }).first();
  await card.getByRole("button", { name: /删除记忆/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText(marker)).toHaveCount(0, { timeout: 25_000 });
});

test("wander-memory: chat streams a reply through the real MemOS WS + dummy LLM", async ({ page }) => {
  await openWanderTab(page);
  await wanderSidebar(page).getByRole("link", { name: /聊天/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/chat/);

  const composer = page.getByPlaceholder("type a message…");
  await expect(composer).toBeVisible({ timeout: 15_000 });
  const query = `e2e聊天 ${Date.now()}`;
  await composer.fill(query);
  await page.getByRole("button", { name: "发送" }).click();

  // The user turn lands in the transcript...
  await expect(page.getByText(query, { exact: true })).toBeVisible({ timeout: 15_000 });
  // ...and the assistant replies with the deterministic dummy-LLM echo
  // ("你说的是：" + the query), streamed through the real MemOS WS.
  await expect(page.getByText(/你说的是/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/你说的是/).first()).not.toBeEmpty({ timeout: 30_000 });
});

test("wander-memory: status shows a healthy MemOS on the default 18400 trio", async ({ page }) => {
  await openWanderTab(page);
  await wanderSidebar(page).getByRole("link", { name: /状态/ }).click();
  await expect(page).toHaveURL(/\/wander-memory\/status/);

  // health card: status ok + the remote model
  const healthCard = page
    .locator("section", { has: page.getByRole("heading", { name: "health" }) })
    .first();
  await expect(healthCard.getByText("ok", { exact: true })).toBeVisible({ timeout: 25_000 });
  await expect(healthCard.getByText("dummy", { exact: true })).toBeVisible({ timeout: 25_000 });

  // endpoint display resolves to the default trio (env/ui-store empty in the
  // fresh browser context → defaults).
  const endpointSection = page
    .locator("section", { has: page.getByRole("heading", { name: "endpoint settings" }) })
    .first();
  await expect(endpointSection.getByText("http://127.0.0.1:18400", { exact: true })).toBeVisible(
    { timeout: 25_000 },
  );
  await expect(endpointSection.getByText("ws://127.0.0.1:18401/v1/ws", { exact: true })).toBeVisible();
});
