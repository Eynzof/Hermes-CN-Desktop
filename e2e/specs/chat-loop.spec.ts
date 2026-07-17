import { test, expect, type Page } from "@playwright/test";

// The core chat closed loop, driven through the real UI:
//   new-chat page  ->  type  ->  send  ->  navigate to /tasks/:id
//   ->  streamed assistant reply  ->  continue the conversation in history.
// Backed by the real Core gateway + the deterministic fake model (replies start
// with "PONG"), so this asserts behavior, not LLM wording.

const composer = (page: Page) => page.getByRole("textbox", { name: "输入消息" });
const sendButton = (page: Page) => page.getByRole("button", { name: "发送消息" });

test("new chat → streamed reply → navigate to history → continue", async ({ page }) => {
  await page.goto("/");

  // 1. New-conversation page: type and send. Distinctive tokens let us tell the
  //    two turns apart (the fake model echoes the prompt back in its reply).
  await expect(composer(page)).toBeVisible();
  await composer(page).fill("alpha-marker");
  await sendButton(page).click();

  // 2. App creates a session and routes to the conversation-history page.
  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });

  // 3. The assistant's streamed reply (echoing turn 1) lands in the message log.
  const lastAssistant = () => page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant()).toContainText("PONG", { timeout: 25_000 });
  await expect(lastAssistant()).toContainText("alpha-marker");

  // 4. Continue the conversation in the same session: a fresh reply that echoes
  //    turn 2 proves the history page keeps the loop alive.
  await composer(page).fill("bravo-marker");
  await sendButton(page).click();
  await expect(lastAssistant()).toContainText("bravo-marker", { timeout: 25_000 });
});

test("streamed reply keeps following the latest message at the bottom", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.goto("/");

  await composer(page).fill("scroll-follow-e2e");
  await sendButton(page).click();
  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });

  const timeline = page.getByRole("log");
  await expect(timeline).toBeVisible();
  await timeline.evaluate((element) => {
    const samples: number[] = [];
    const recordBottomDistance = () => {
      samples.push(
        Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight),
      );
    };
    const observer = new MutationObserver(recordBottomDistance);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    recordBottomDistance();
    Object.assign(window, { __scrollFollowSamples: samples, __scrollFollowObserver: observer });
  });

  const lastAssistant = page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant).toContainText("scroll-follow-token-119", { timeout: 25_000 });

  const result = await timeline.evaluate((element) => {
    const runtime = window as Window & {
      __scrollFollowSamples?: number[];
      __scrollFollowObserver?: MutationObserver;
    };
    runtime.__scrollFollowObserver?.disconnect();
    const samples = runtime.__scrollFollowSamples ?? [];
    return {
      finalDistance: Math.max(
        0,
        element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
      maxDistance: Math.max(0, ...samples),
    };
  });

  expect(result.finalDistance).toBeLessThanOrEqual(8);
  // One line can be observed between the DOM mutation and React's layout
  // effect, but the viewport must never drift by multiple rendered lines.
  expect(result.maxDistance).toBeLessThanOrEqual(32);
});
