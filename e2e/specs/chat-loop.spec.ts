import { test, expect, type Page } from "@playwright/test";

// The core chat closed loop, driven through the real UI:
//   new-chat page  ->  type  ->  send  ->  navigate to /tasks/:id
//   ->  streamed assistant reply  ->  continue the conversation in history.
// Backed by the real Core gateway + the deterministic fake model, so this
// asserts behavior, not LLM wording.

const composer = (page: Page) => page.getByRole("textbox", { name: "输入消息" });
const sendButton = (page: Page) => page.getByRole("button", { name: "发送消息" });

test("new chat → streamed reply → navigate to history → continue", async ({ page }) => {
  await page.goto("/");

  // 1. New-conversation page: the marker selects a deliberately long fake
  //    response that spans many Core token-coalescing windows.
  await expect(composer(page)).toBeVisible();
  await composer(page).fill("stream-order-marker");
  await sendButton(page).click();

  // 2. App creates a session and routes to the conversation-history page.
  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });

  // 3. The assistant's long streamed reply lands in the message log.
  const lastAssistant = () => page.getByRole("log").locator('[data-role="assistant"]').last();
  await expect(lastAssistant()).toContainText("STREAM-ORDER-BEGIN", { timeout: 25_000 });
  await expect(lastAssistant()).toContainText("STREAM-ORDER-END");

  // Let the canonical history refetch merge with the completed live row. The
  // regression rendered both rows because the corrupt live stream differed
  // from the persisted final text.
  const assistantRows = page
    .getByRole("log")
    .locator('[data-role="assistant"]:has(button[title="朗读回复"])');
  await page.waitForTimeout(750);
  await expect(assistantRows).toHaveCount(1);
  const firstReplyText = await assistantRows.first().innerText();
  expect(firstReplyText.match(/STREAM-ORDER-BEGIN/g)).toHaveLength(1);
  expect(firstReplyText.match(/STREAM-ORDER-END/g)).toHaveLength(1);

  // 4. Continue the conversation in the same session: a fresh reply that echoes
  //    turn 2 proves the history page keeps the loop alive.
  await composer(page).fill("bravo-marker");
  await sendButton(page).click();
  await expect(lastAssistant()).toContainText("bravo-marker", { timeout: 25_000 });
  await expect(assistantRows).toHaveCount(2);
});
