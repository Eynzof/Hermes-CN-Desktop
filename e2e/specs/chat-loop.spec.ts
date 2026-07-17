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
  await expect.poll(() => timeline.evaluate((element) => (
    Math.max(
      0,
      element.scrollHeight - element.scrollTop - element.clientHeight,
    )
  ))).toBeLessThanOrEqual(8);
  await timeline.evaluate((element) => {
    const samples: number[] = [];
    const recordBottomDistance = () => {
      samples.push(
        Math.max(0, element.scrollHeight - element.scrollTop - element.clientHeight),
      );
      Object.assign(window, {
        __scrollFollowFrame: window.requestAnimationFrame(recordBottomDistance),
      });
    };
    recordBottomDistance();
    Object.assign(window, { __scrollFollowSamples: samples });
  });

  const lastAssistant = page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant).toContainText("scroll-follow-token-299", { timeout: 25_000 });

  const result = await timeline.evaluate((element) => {
    const runtime = window as Window & {
      __scrollFollowSamples?: number[];
      __scrollFollowFrame?: number;
    };
    if (runtime.__scrollFollowFrame != null) {
      window.cancelAnimationFrame(runtime.__scrollFollowFrame);
    }
    const samples = runtime.__scrollFollowSamples ?? [];
    let consecutiveDriftFrames = 0;
    let maxConsecutiveDriftFrames = 0;
    for (const distance of samples) {
      consecutiveDriftFrames = distance > 100 ? consecutiveDriftFrames + 1 : 0;
      maxConsecutiveDriftFrames = Math.max(
        maxConsecutiveDriftFrames,
        consecutiveDriftFrames,
      );
    }
    return {
      finalDistance: Math.max(
        0,
        element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
      maxDistance: Math.max(0, ...samples),
      maxConsecutiveDriftFrames,
      viewportHeight: element.clientHeight,
    };
  });

  expect(result.finalDistance).toBeLessThanOrEqual(8);
  // Sample painted frames rather than pre-layout DOM mutation microtasks: the
  // user-visible viewport may absorb one batched layout update, but it must not
  // remain detached or let the latest content fall a full viewport behind.
  expect(result.maxConsecutiveDriftFrames).toBeLessThanOrEqual(2);
  expect(result.maxDistance).toBeLessThan(result.viewportHeight);
});
