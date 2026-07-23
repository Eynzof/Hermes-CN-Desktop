import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT || 9120);
const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_PORT}`;
const DASHBOARD_TOKEN = process.env.E2E_DASHBOARD_TOKEN || "e2e-token";
const SOURCE = "profile-e2e-source";
const CLONE = "profile-e2e-clone";
const RENAMED = "profile-e2e-renamed";
const MAX_NAME = `p${"x".repeat(63)}`;
const TEST_PROFILES = [SOURCE, CLONE, RENAMED, MAX_NAME] as const;
const SOURCE_SOUL = "# Profile E2E Source\n\n只输出经过审查的结论。\n";
const CLONE_SOUL = "# Profile E2E Clone\n\n专注寻找反例，不修改来源档案。\n";

const dashboardHeaders = {
  Authorization: `Bearer ${DASHBOARD_TOKEN}`,
};

interface ProfileSummary {
  name: string;
  path: string;
  model?: string | null;
  provider?: string | null;
  description?: string;
  skill_count: number;
}

interface ProfilesResponse {
  profiles: ProfileSummary[];
}

interface ActiveProfileResponse {
  active: string;
  current: string;
}

const profileCard = (page: Page, name: string) =>
  page.locator(`[data-profile-name="${name}"]`);

const visibleProfileSelector = (page: Page) =>
  page.locator('button[title="当前档案 · 点击切换"]:visible').first();

const openActionMenu = (page: Page) =>
  page.locator('[role="menu"][data-state="open"]');

async function expectApiOk(response: APIResponse, label: string) {
  if (!response.ok()) {
    expect(
      response.ok(),
      `${label} 失败（HTTP ${response.status()}）：${await response.text()}`,
    ).toBeTruthy();
  }
}

async function listProfiles(request: APIRequestContext): Promise<ProfileSummary[]> {
  const response = await request.get(`${DASHBOARD_ORIGIN}/api/profiles`, {
    headers: dashboardHeaders,
  });
  await expectApiOk(response, "读取 Profile 列表");
  return ((await response.json()) as ProfilesResponse).profiles;
}

async function activeProfile(
  request: APIRequestContext,
): Promise<ActiveProfileResponse> {
  const response = await request.get(`${DASHBOARD_ORIGIN}/api/profiles/active`, {
    headers: dashboardHeaders,
  });
  await expectApiOk(response, "读取当前 Profile");
  return (await response.json()) as ActiveProfileResponse;
}

async function resetTestProfiles(request: APIRequestContext) {
  const reset = await request.post(`${DASHBOARD_ORIGIN}/api/profiles/active`, {
    headers: dashboardHeaders,
    data: { name: "default" },
  });
  await expectApiOk(reset, "恢复 default Profile");

  for (const name of TEST_PROFILES) {
    const response = await request.delete(
      `${DASHBOARD_ORIGIN}/api/profiles/${encodeURIComponent(name)}`,
      { headers: dashboardHeaders },
    );
    if (!response.ok() && response.status() !== 404) {
      expect(
        false,
        `清理 ${name} 失败（HTTP ${response.status()}）：${await response.text()}`,
      ).toBeTruthy();
    }
  }
}

async function openProfileAction(page: Page, name: string, action: string) {
  await page.getByRole("button", { name: `${name} 的操作` }).click();
  const menu = openActionMenu(page);
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: action, exact: true }).click();
}

async function createProfileViaUi(
  page: Page,
  input: {
    name: string;
    cloneFrom?: string;
    description?: string;
    noSkills?: boolean;
  },
) {
  await page.getByRole("button", { name: "新建档案" }).click();
  const dialog = page.getByRole("dialog", { name: "新建档案" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("例如 work / sandbox").fill(input.name);
  if (input.cloneFrom) {
    await dialog.locator("select").first().selectOption(input.cloneFrom);
  }
  if (input.description) {
    await dialog
      .getByPlaceholder("一两句话说明这个档案的角色。")
      .fill(input.description);
  }
  if (input.noSkills) {
    await dialog.getByRole("button", { name: "高级选项" }).click();
    await dialog.getByRole("checkbox").nth(1).check();
  }
  await dialog.getByRole("button", { name: "创建" }).click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
  await expect(profileCard(page, input.name)).toBeVisible({ timeout: 30_000 });
}

async function editSoul(page: Page, name: string, content: string) {
  await openProfileAction(page, name, "编辑 SOUL.md");
  const dialog = page.getByRole("dialog", {
    name: new RegExp(`编辑 SOUL\\.md.*${name}`),
  });
  const textarea = dialog.locator("textarea");
  await expect(textarea).toBeVisible();
  await textarea.fill(content);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
}

async function readSoulFromUi(page: Page, name: string): Promise<string> {
  await openProfileAction(page, name, "编辑 SOUL.md");
  const dialog = page.getByRole("dialog", {
    name: new RegExp(`编辑 SOUL\\.md.*${name}`),
  });
  const textarea = dialog.locator("textarea");
  await expect(textarea).toBeVisible();
  const content = await textarea.inputValue();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toBeHidden();
  return content;
}

async function editDescription(page: Page, name: string, description: string) {
  await openProfileAction(page, name, "改描述");
  const dialog = page.getByRole("dialog", {
    name: new RegExp(`改描述.*${name}`),
  });
  await dialog.locator("textarea").fill(description);
  await dialog.getByRole("button", { name: "保存" }).click();
  await expect(dialog).toBeHidden();
  await expect(profileCard(page, name)).toContainText(description);
}

test.describe("Profile 全链路", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await resetTestProfiles(request);
  });

  test.afterAll(async ({ request }) => {
    await resetTestProfiles(request);
  });

  test("认证、列表与反复刷新保持稳定，不出现“未接入”闪烁", async ({
    page,
    request,
  }) => {
    const unauthenticated = await request.get(`${DASHBOARD_ORIGIN}/api/profiles`);
    expect(unauthenticated.status()).toBe(401);

    const profileStatuses: number[] = [];
    page.on("response", (response) => {
      const path = new URL(response.url()).pathname;
      if (path === "/api/profiles" || path === "/api/profiles/active") {
        profileStatuses.push(response.status());
      }
    });

    await page.goto("/profiles");
    await expect(profileCard(page, "default")).toBeVisible();
    await expect(visibleProfileSelector(page)).toContainText("default");
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __HERMES_SESSION_TOKEN__?: string })
            .__HERMES_SESSION_TOKEN__,
      ),
    ).toBe(DASHBOARD_TOKEN);

    const observedLabels = await page.evaluate(async () => {
      const selector = document.querySelector(
        'button[title="当前档案 · 点击切换"]',
      );
      if (!selector) return ["missing-selector"];
      const labels = [selector.textContent ?? ""];
      const observer = new MutationObserver(() => {
        labels.push(selector.textContent ?? "");
      });
      observer.observe(selector, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 1_200));
      observer.disconnect();
      return labels;
    });
    expect(observedLabels).not.toContain("missing-selector");
    expect(observedLabels.some((label) => label.includes("未接入"))).toBe(false);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.reload();
      await expect(profileCard(page, "default")).toBeVisible();
      await expect(visibleProfileSelector(page)).toContainText("default");
      await expect(visibleProfileSelector(page)).not.toContainText("未接入");
    }

    await visibleProfileSelector(page).click();
    await expect(page.getByText("切换档案", { exact: true })).toBeVisible();
    await expect(page.getByText("加载中…", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    expect(profileStatuses.length).toBeGreaterThanOrEqual(8);
    expect(new Set(profileStatuses)).toEqual(new Set([200]));
  });

  test("创建边界、重复名、保留名和路径穿越均按契约处理", async ({
    page,
    request,
  }) => {
    await page.goto("/profiles");
    await page.getByRole("button", { name: "新建档案" }).click();
    const dialog = page.getByRole("dialog", { name: "新建档案" });
    const nameInput = dialog.getByPlaceholder("例如 work / sandbox");

    await nameInput.fill("Upper Case");
    await dialog.getByRole("button", { name: "创建" }).click();
    await expect(dialog).toContainText("只允许小写字母");

    await nameInput.fill(`p${"x".repeat(64)}`);
    await dialog.getByRole("button", { name: "创建" }).click();
    await expect(dialog).toContainText("最长 64 字符");

    await nameInput.fill(MAX_NAME);
    await dialog.getByRole("button", { name: "高级选项" }).click();
    await dialog.getByRole("checkbox").nth(1).check();
    await dialog.getByRole("button", { name: "创建" }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(profileCard(page, MAX_NAME)).toContainText("0 个技能");

    await page.getByRole("button", { name: "新建档案" }).click();
    const duplicateDialog = page.getByRole("dialog", { name: "新建档案" });
    await duplicateDialog.getByPlaceholder("例如 work / sandbox").fill(MAX_NAME);
    await duplicateDialog.getByRole("button", { name: "创建" }).click();
    await expect(duplicateDialog).toContainText("已存在同名档案");
    await duplicateDialog.getByRole("button", { name: "取消" }).click();

    const traversal = await request.post(`${DASHBOARD_ORIGIN}/api/profiles`, {
      headers: dashboardHeaders,
      data: { name: "../escape" },
    });
    expect(traversal.status()).toBe(400);

    const reserved = await request.post(`${DASHBOARD_ORIGIN}/api/profiles`, {
      headers: dashboardHeaders,
      data: { name: "root" },
    });
    expect(reserved.status()).toBe(400);

    const profiles = await listProfiles(request);
    expect(
      profiles
        .find((profile) => profile.name === MAX_NAME)
        ?.path.replaceAll("\\", "/"),
    ).toContain("/e2e/.runtime/hermes-home/profiles/");
    expect(JSON.stringify(profiles)).not.toContain("e2e-test-key");

    await createProfileViaUi(page, {
      name: SOURCE,
      cloneFrom: "default",
      description: "来源档案初始描述",
    });
  });

  test("克隆后 SOUL、描述、模型和管理范围保持 Profile 隔离", async ({
    page,
    request,
  }) => {
    await page.goto("/profiles");
    await editSoul(page, SOURCE, SOURCE_SOUL);
    await editDescription(page, SOURCE, "来源档案：负责提出方案");

    const sourceModel = await request.put(
      `${DASHBOARD_ORIGIN}/api/profiles/${SOURCE}/model`,
      {
        headers: dashboardHeaders,
        data: { provider: "custom", model: "profile-source-model" },
      },
    );
    await expectApiOk(sourceModel, "设置来源档案模型");

    await page.reload();
    await expect(profileCard(page, SOURCE)).toContainText("profile-source-model");
    await createProfileViaUi(page, {
      name: CLONE,
      cloneFrom: SOURCE,
      description: "克隆档案：负责红队审查",
    });
    await expect(profileCard(page, CLONE)).toContainText("profile-source-model");
    expect(await readSoulFromUi(page, CLONE)).toBe(SOURCE_SOUL);

    await editSoul(page, CLONE, CLONE_SOUL);
    await editDescription(page, CLONE, "克隆档案：只负责寻找反例");
    const persistedCloneSoul = await request.get(
      `${DASHBOARD_ORIGIN}/api/profiles/${CLONE}/soul`,
      { headers: dashboardHeaders },
    );
    await expectApiOk(persistedCloneSoul, "回读克隆档案 SOUL");
    expect(
      ((await persistedCloneSoul.json()) as { content: string }).content,
    ).toBe(CLONE_SOUL);
    expect(await readSoulFromUi(page, SOURCE)).toBe(SOURCE_SOUL);
    expect(await readSoulFromUi(page, CLONE)).toBe(CLONE_SOUL);
    await expect(profileCard(page, SOURCE)).toContainText("来源档案：负责提出方案");
    await expect(profileCard(page, CLONE)).toContainText("克隆档案：只负责寻找反例");

    const cloneModel = await request.put(
      `${DASHBOARD_ORIGIN}/api/profiles/${CLONE}/model`,
      {
        headers: dashboardHeaders,
        data: { provider: "custom", model: "profile-clone-model" },
      },
    );
    await expectApiOk(cloneModel, "设置克隆档案模型");
    const profiles = await listProfiles(request);
    expect(profiles.find((profile) => profile.name === SOURCE)?.model).toBe(
      "profile-source-model",
    );
    expect(profiles.find((profile) => profile.name === CLONE)?.model).toBe(
      "profile-clone-model",
    );

    await openProfileAction(page, SOURCE, "管理技能");
    await expect(page).toHaveURL(new RegExp(`/skills\\?profile=${SOURCE}$`));
    await expect(
      page.getByRole("status").filter({ hasText: `正在管理档案 ${SOURCE}` }),
    ).toBeVisible();
  });

  test("切换、刷新、活动档案改名、保护性禁用和删除保持一致", async ({
    page,
    request,
  }) => {
    await page.goto("/profiles");

    await openProfileAction(page, CLONE, "设为默认");
    await expect(visibleProfileSelector(page)).toContainText(CLONE);
    await expect(page.getByText("默认档案与当前运行的不一致")).toBeVisible();
    await expect
      .poll(() => activeProfile(request))
      .toMatchObject({ active: CLONE, current: "default" });

    await page.getByRole("button", { name: `${CLONE} 的操作` }).click();
    await expect(
      openActionMenu(page).getByRole("menuitem", { name: "删除", exact: true }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");

    await page.reload();
    await expect(visibleProfileSelector(page)).toContainText(CLONE);
    await expect(profileCard(page, CLONE)).toHaveAttribute("data-active", "true");

    await openProfileAction(page, CLONE, "重命名");
    const renameDialog = page.getByRole("dialog", {
      name: new RegExp(`重命名档案.*${CLONE}`),
    });
    await renameDialog.locator("input").fill(RENAMED);
    await renameDialog.getByRole("button", { name: "保存" }).click();
    await expect(renameDialog).toBeHidden();
    await expect(profileCard(page, CLONE)).toHaveCount(0);
    await expect(profileCard(page, RENAMED)).toBeVisible();
    await expect(visibleProfileSelector(page)).toContainText(RENAMED);
    await expect
      .poll(() => activeProfile(request))
      .toMatchObject({ active: RENAMED, current: "default" });

    await page.reload();
    await expect(visibleProfileSelector(page)).toContainText(RENAMED);
    await expect(profileCard(page, RENAMED)).toHaveAttribute("data-active", "true");

    await page.getByRole("button", { name: "default 的操作" }).click();
    const defaultMenu = openActionMenu(page);
    await expect(defaultMenu.getByRole("menuitem", { name: "重命名" })).toHaveCount(0);
    await expect(defaultMenu.getByRole("menuitem", { name: "删除" })).toHaveCount(0);
    await defaultMenu.getByRole("menuitem", { name: "设为默认", exact: true }).click();
    await expect(visibleProfileSelector(page)).toContainText("default");
    await expect
      .poll(() => activeProfile(request))
      .toMatchObject({ active: "default", current: "default" });

    for (const name of [RENAMED, SOURCE, MAX_NAME]) {
      await openProfileAction(page, name, "删除");
      const deleteDialog = page.getByRole("dialog", {
        name: new RegExp(`删除档案.*${name}`),
      });
      await deleteDialog.getByRole("button", { name: "确认删除" }).click();
      await expect(deleteDialog).toBeHidden();
      await expect(profileCard(page, name)).toHaveCount(0);
    }

    expect((await listProfiles(request)).map((profile) => profile.name)).toEqual([
      "default",
    ]);
  });
});
