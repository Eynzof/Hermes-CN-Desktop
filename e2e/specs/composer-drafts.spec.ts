import { expect, test, type Page } from "@playwright/test";

const composer = (page: Page) => page.getByRole("textbox", { name: "输入消息" });
const sendButton = (page: Page) => page.getByRole("button", { name: "发送消息" });

async function createSession(page: Page, prompt: string): Promise<string> {
  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(prompt);
  await sendButton(page).click();
  await expect(page).toHaveURL(/\/tasks\/.+/, { timeout: 20_000 });
  await expect(page.getByRole("log").locator('[data-role="assistant"]').last()).toContainText(prompt, {
    timeout: 25_000,
  });
  return page.url();
}

test("composer drafts survive navigation and stay scoped per target", async ({ page }) => {
  const stamp = Date.now();
  const newTaskDraft = `new-task-draft-${stamp}`;
  const sessionADraft = `session-a-draft-${stamp}`;
  const sessionBDraft = `session-b-draft-${stamp}`;

  await page.goto("/");
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(newTaskDraft);
  await page.goto("/history");
  await page.goto("/");
  await expect(composer(page)).toHaveValue(newTaskDraft);
  await composer(page).fill("");
  await expect(composer(page)).toHaveValue("");

  const sessionAUrl = await createSession(page, `draft-session-a-seed-${stamp}`);
  const sessionBUrl = await createSession(page, `draft-session-b-seed-${stamp}`);

  await page.goto(sessionAUrl);
  await expect(composer(page)).toBeVisible();
  await composer(page).fill(sessionADraft);

  await page.goto(sessionBUrl);
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).toHaveValue("");
  await composer(page).fill(sessionBDraft);

  await page.goto(sessionAUrl);
  await expect(composer(page)).toHaveValue(sessionADraft);
  await page.reload();
  await expect(composer(page)).toHaveValue(sessionADraft);

  await sendButton(page).click();
  await expect(page.getByRole("log").locator('[data-role="assistant"]').last()).toContainText(sessionADraft, {
    timeout: 25_000,
  });
  await page.reload();
  await expect(composer(page)).toHaveValue("");

  await page.goto(sessionBUrl);
  await expect(composer(page)).toHaveValue(sessionBDraft);
});
