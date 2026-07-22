import { expect, test } from "@playwright/test";

const SKILL_NAME = "e2e-agent-skill";

test("connected Core agent skill appears under My Skills and loads its markdown", async ({ page }) => {
  await page.goto("/skills");

  const mySkillsTab = page.getByRole("button", { name: /我的 Skills/ });
  await expect(mySkillsTab).toBeVisible();
  await mySkillsTab.click();

  await page.getByPlaceholder("搜索我的 Skill…").fill(SKILL_NAME);
  const skillRow = page.locator('[role="button"]').filter({ hasText: SKILL_NAME }).first();
  await expect(skillRow).toBeVisible();
  await skillRow.click();

  await expect(page.getByText("用户自建", { exact: true })).toBeVisible();
  await expect(page.getByText("E2E connected-Core markdown marker.")).toBeVisible();
  // The provenance path is rendered with the platform's separator (\\ on
  // Windows, / elsewhere), so accept both.
  await expect(page.getByText(/e2e-agent-skill[/\\]SKILL\.md/).first()).toBeVisible();

  await page.getByRole("button", { name: /内置 Skills/ }).click();
  await page.getByPlaceholder("搜索 Skill 名 / 描述…").fill(SKILL_NAME);
  await expect(page.getByText("没有匹配的技能。", { exact: true })).toBeVisible();
});
