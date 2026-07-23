import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

const GROUP_CHAT_ENABLED = process.env.E2E_GROUPCHAT === "1";
const GROUP_CHAT_STRESS_ENABLED = process.env.E2E_GROUPCHAT_STRESS === "1";
const DASHBOARD_PORT = Number(process.env.E2E_DASHBOARD_PORT || 9120);
const DASHBOARD_ORIGIN = `http://127.0.0.1:${DASHBOARD_PORT}`;
const DASHBOARD_TOKEN = process.env.E2E_DASHBOARD_TOKEN || "e2e-token";
const PROFILE_SPECS = [
  { name: "qa-planner", description: "方案提出者，负责给出可执行方案" },
  { name: "qa-critic", description: "红队审查者，负责发现风险与反例" },
  { name: "qa-synthesizer", description: "决策主持人，负责综合各方结论" },
  { name: "qa-failing", description: "故障注入成员，仅用于验证失败隔离" },
] as const;

const dashboardHeaders = {
  Authorization: `Bearer ${DASHBOARD_TOKEN}`,
};

const composer = (page: Page) => page.getByRole("textbox", { name: "输入消息" });
const sendButton = (page: Page) => page.getByRole("button", { name: "发送消息" });
const completedAssistantRows = (page: Page) =>
  page
    .getByRole("log")
    .locator('[data-role="assistant"]:has(button[title="朗读回复"])');

async function ensureProfiles(request: APIRequestContext) {
  const listResponse = await request.get(`${DASHBOARD_ORIGIN}/api/profiles`, {
    headers: dashboardHeaders,
  });
  expect(listResponse.ok()).toBeTruthy();
  const existing = new Set(
    ((await listResponse.json()) as { profiles?: Array<{ name?: string }> }).profiles
      ?.map((profile) => profile.name)
      .filter((name): name is string => Boolean(name)) ?? [],
  );

  for (const profile of PROFILE_SPECS) {
    if (existing.has(profile.name)) continue;
    const createResponse = await request.post(`${DASHBOARD_ORIGIN}/api/profiles`, {
      headers: dashboardHeaders,
      data: {
        name: profile.name,
        clone_from: "default",
        description: profile.description,
      },
    });
    expect(
      createResponse.ok(),
      `创建测试 Profile ${profile.name} 失败：${await createResponse.text()}`,
    ).toBeTruthy();
  }
}

async function createGroup(
  page: Page,
  members: readonly string[],
  title: string,
): Promise<string> {
  await page.goto("/");
  await page.getByRole("button", { name: "新建群聊" }).click();

  const dialog = page.getByRole("dialog", { name: "新建群聊" });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("群聊名称（可选）").fill(title);
  for (const member of members) {
    const row = dialog.getByText(member, { exact: true }).locator("..");
    await row.getByRole("checkbox").check();
  }
  await dialog.getByRole("button", { name: `创建（${members.length}）` }).click();
  await expect(page).toHaveURL(/\/tasks\/gc_[^/]+$/, { timeout: 20_000 });
  await expect(page.getByText(`${members.length} 位成员`, { exact: true })).toBeVisible();

  const roomId = new URL(page.url()).pathname.split("/").filter(Boolean).at(-1);
  expect(roomId).toMatch(/^gc_/);
  return roomId as string;
}

async function submitAndWait(
  page: Page,
  text: string,
  expectedCompletedIncrement: number,
) {
  const completedBefore = await completedAssistantRows(page).count();
  await composer(page).fill(text);
  await sendButton(page).click();
  await expect.poll(() => composer(page).inputValue(), { timeout: 45_000 }).toBe("");
  await expect(completedAssistantRows(page)).toHaveCount(
    completedBefore + expectedCompletedIncrement,
    { timeout: 45_000 },
  );
}

test.describe("P-052 多 Agent 群聊复杂场景", () => {
  test.skip(
    !GROUP_CHAT_ENABLED,
    "配对 Core PR 合并前需显式设置 E2E_GROUPCHAT=1 才运行群聊跨仓用例",
  );
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ request }) => {
    await ensureProfiles(request);
  });

  test("三成员独立回答、定向总结和多成员路由保持上下文与顺序", async ({
    page,
    request,
  }) => {
    const roomId = await createGroup(
      page,
      ["qa-planner", "qa-critic", "qa-synthesizer"],
      "复杂协作评审",
    );

    await composer(page).fill("@");
    const mentionOptions = page
      .getByRole("listbox", { name: "插入引用" })
      .getByRole("option");
    await expect(mentionOptions).toHaveCount(4);
    await expect(mentionOptions.nth(0)).toContainText("@all");
    await expect(mentionOptions.nth(1)).toContainText("@qa-planner");
    await expect(mentionOptions.nth(2)).toContainText("@qa-critic");
    await expect(mentionOptions.nth(3)).toContainText("@qa-synthesizer");

    await submitAndWait(page, "group-context-e2e phase-one", 3);
    await expect(completedAssistantRows(page)).toHaveCount(3);
    for (const member of ["qa-planner", "qa-critic", "qa-synthesizer"]) {
      const row = completedAssistantRows(page).filter({ hasText: `agent=${member}` });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("seen=none");
    }

    await submitAndWait(
      page,
      "@qa-synthesizer group-context-e2e phase-two",
      1,
    );
    await expect(completedAssistantRows(page)).toHaveCount(4);
    await expect(completedAssistantRows(page).last()).toContainText(
      "GROUP-CONTEXT agent=qa-synthesizer seen=qa-critic,qa-planner",
    );

    await submitAndWait(
      page,
      "@qa-critic @qa-planner group-context-e2e phase-three",
      2,
    );
    await expect(completedAssistantRows(page)).toHaveCount(6);
    await expect(completedAssistantRows(page).nth(4)).toContainText(
      "agent=qa-planner",
    );
    await expect(completedAssistantRows(page).nth(5)).toContainText(
      "agent=qa-critic",
    );

    const transcriptResponse = await request.get(
      `${DASHBOARD_ORIGIN}/api/sessions/${roomId}/messages`,
      { headers: dashboardHeaders },
    );
    expect(transcriptResponse.ok()).toBeTruthy();
    const transcript = (await transcriptResponse.json()) as {
      messages: Array<{ role?: string; sender_name?: string }>;
    };
    expect(
      transcript.messages
        .filter((message) => message.role === "assistant")
        .map((message) => message.sender_name),
    ).toEqual([
      "qa-planner",
      "qa-critic",
      "qa-synthesizer",
      "qa-synthesizer",
      "qa-planner",
      "qa-critic",
    ]);
  });

  test("@all、大小写、中文标点、相似名称和引用块遵守 mention 边界", async ({
    page,
  }) => {
    await createGroup(
      page,
      ["qa-planner", "qa-critic", "qa-synthesizer"],
      "Mention 边界验证",
    );

    await submitAndWait(page, "@all group-context-e2e all-members", 3);
    await expect(completedAssistantRows(page)).toHaveCount(3);

    await submitAndWait(page, "@QA-CRITIC group-context-e2e case-insensitive", 1);
    await expect(completedAssistantRows(page)).toHaveCount(4);
    await expect(completedAssistantRows(page).last()).toContainText(
      "agent=qa-critic",
    );

    await submitAndWait(page, "@qa-planner，group-context-e2e cjk-punctuation", 1);
    await expect(completedAssistantRows(page)).toHaveCount(5);
    await expect(completedAssistantRows(page).last()).toContainText(
      "agent=qa-planner",
    );

    await submitAndWait(
      page,
      "@qa-planner-extra group-context-e2e similar-name-must-not-match",
      0,
    );
    await expect(completedAssistantRows(page)).toHaveCount(5);

    await submitAndWait(
      page,
      [
        "<quoted_message>@qa-planner 旧消息中的伪 mention</quoted_message>",
        "group-context-e2e quoted-mention-must-not-route",
      ].join(" "),
      0,
    );
    await expect(completedAssistantRows(page)).toHaveCount(5);
  });

  test("三成员长流按身份拆分且没有丢失、重复或串气泡", async ({ page }) => {
    await createGroup(
      page,
      ["qa-planner", "qa-critic", "qa-synthesizer"],
      "长流顺序验证",
    );

    await submitAndWait(page, "group-long-stream-e2e", 3);
    await expect(completedAssistantRows(page)).toHaveCount(3);
    for (const member of ["qa-planner", "qa-critic", "qa-synthesizer"]) {
      const row = completedAssistantRows(page).filter({
        hasText: `GROUP-LONG-BEGIN|agent=${member}|`,
      });
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("GROUP-LONG-END");
      const text = await row.innerText();
      expect(text.match(/GROUP-LONG-BEGIN/g)).toHaveLength(1);
      expect(text.match(/GROUP-LONG-END/g)).toHaveLength(1);
    }
  });

  test("单成员模型失败不会阻断后续成员且错误归属失败成员", async ({ page }) => {
    await createGroup(
      page,
      ["qa-planner", "qa-failing", "qa-critic"],
      "成员失败隔离",
    );

    await submitAndWait(page, "group-failure-e2e", 2);
    const planner = completedAssistantRows(page).filter({
      hasText: "GROUP-FAILURE-SURVIVOR agent=qa-planner",
    });
    const critic = completedAssistantRows(page).filter({
      hasText: "GROUP-FAILURE-SURVIVOR agent=qa-critic",
    });
    await expect(planner).toHaveCount(1);
    await expect(critic).toHaveCount(1);

    const failureRow = page
      .getByRole("log")
      .locator('[data-role="assistant"]')
      .filter({ hasText: "intentional group E2E member failure" })
      .first();
    await expect(failureRow).toContainText("qa-failing");
  });

  test("内部成员子会话不会泄漏到任一 Profile 的公开会话列表", async ({
    page,
    request,
  }) => {
    const members = ["qa-planner", "qa-critic"] as const;
    const roomId = await createGroup(page, members, "内部会话隔离");
    await submitAndWait(page, "group-context-e2e session-leak-check", 2);

    for (const profile of members) {
      const response = await request.get(
        `${DASHBOARD_ORIGIN}/api/sessions?limit=100&profile=${encodeURIComponent(profile)}`,
        { headers: dashboardHeaders },
      );
      expect(response.ok()).toBeTruthy();
      const body = (await response.json()) as {
        sessions?: Array<{ id?: string }>;
      };
      const leakedIds = (body.sessions ?? [])
        .map((session) => session.id ?? "")
        .filter((id) => id.startsWith(`${roomId}:`));
      expect(leakedIds).toEqual([]);
    }
  });

  test("三成员二十轮混合路由保持身份、消息数量和上下文增长稳定", async ({
    page,
    request,
  }) => {
    test.skip(
      !GROUP_CHAT_STRESS_ENABLED,
      "压力用例需额外设置 E2E_GROUPCHAT_STRESS=1",
    );
    test.setTimeout(180_000);

    const roomId = await createGroup(
      page,
      ["qa-planner", "qa-critic", "qa-synthesizer"],
      "二十轮混合路由压力",
    );
    const expectedSenders: string[] = [];
    const latencies: number[] = [];
    const uiAssistantCounts: number[] = [];
    const patterns = [
      {
        prompt: "@qa-planner group-context-e2e stress-target",
        senders: ["qa-planner"],
      },
      {
        prompt: "@qa-synthesizer @qa-critic group-context-e2e stress-multi",
        senders: ["qa-critic", "qa-synthesizer"],
      },
      {
        prompt: "group-context-e2e stress-plain-all",
        senders: ["qa-planner", "qa-critic", "qa-synthesizer"],
      },
      {
        prompt: "@all group-context-e2e stress-explicit-all",
        senders: ["qa-planner", "qa-critic", "qa-synthesizer"],
      },
    ] as const;

    for (let round = 0; round < 20; round += 1) {
      const pattern = patterns[round % patterns.length];
      const startedAt = Date.now();
      await submitAndWait(
        page,
        `${pattern.prompt} round-${round + 1}`,
        pattern.senders.length,
      );
      latencies.push(Date.now() - startedAt);
      expectedSenders.push(...pattern.senders);
      uiAssistantCounts.push(await completedAssistantRows(page).count());
    }

    const transcriptResponse = await request.get(
      `${DASHBOARD_ORIGIN}/api/sessions/${roomId}/messages`,
      { headers: dashboardHeaders },
    );
    expect(transcriptResponse.ok()).toBeTruthy();
    const transcript = (await transcriptResponse.json()) as {
      messages: Array<{ role?: string; sender_name?: string }>;
    };
    const actualSenders = transcript.messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.sender_name);
    const userMessageCount = transcript.messages.filter(
      (message) => message.role === "user",
    ).length;
    const firstUiMismatchIndex = uiAssistantCounts.findIndex(
      (count, index) => {
        const expectedAtRound = patterns
          .slice(0, (index % patterns.length) + 1)
          .reduce((total, pattern) => total + pattern.senders.length, 0);
        const completedCycles = Math.floor(index / patterns.length);
        const expectedPerCycle = patterns.reduce(
          (total, pattern) => total + pattern.senders.length,
          0,
        );
        return count !== completedCycles * expectedPerCycle + expectedAtRound;
      },
    );

    const sortedLatencies = [...latencies].sort((left, right) => left - right);
    const percentile = (ratio: number) =>
      sortedLatencies[Math.ceil(sortedLatencies.length * ratio) - 1];
    console.log(
      `[groupchat-stress] ${JSON.stringify({
        rounds: 20,
        assistant_messages: actualSenders.length,
        transcript_messages: transcript.messages.length,
        stable_senders: new Set(actualSenders).size,
        rest_sender_sequence_ok:
          JSON.stringify(actualSenders) === JSON.stringify(expectedSenders),
        ui_assistant_bubbles: uiAssistantCounts.at(-1),
        expected_assistant_bubbles: expectedSenders.length,
        first_ui_mismatch_round:
          firstUiMismatchIndex === -1 ? null : firstUiMismatchIndex + 1,
        latency_ms: {
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: sortedLatencies.at(-1),
        },
      })}`,
    );

    expect(actualSenders).toEqual(expectedSenders);
    expect(userMessageCount).toBe(20);
    expect(
      firstUiMismatchIndex,
      "BUG-GC-003：压力轮次中出现重复气泡或跨成员文本合并",
    ).toBe(-1);
    expect(await completedAssistantRows(page).count()).toBe(
      expectedSenders.length,
    );
  });

  test("发送后 500ms 内清空草稿", async ({ page }) => {
    await createGroup(page, ["qa-planner", "qa-critic"], "草稿清空时延");

    await composer(page).fill("group-long-stream-e2e");
    await sendButton(page).click();
    await page.waitForTimeout(500);
    const valueAt500ms = await composer(page).inputValue();
    await expect.poll(() => composer(page).inputValue(), { timeout: 45_000 }).toBe("");
    await expect(completedAssistantRows(page)).toHaveCount(2, { timeout: 45_000 });
    expect(valueAt500ms).toBe("");
  });

  test("停止按钮可以中止剩余群成员回复", async ({ page }) => {
    test.fail(
      true,
      "群聊成员使用独立子会话，当前对房间 ID 的 session.interrupt 不保证中止它们",
    );
    await createGroup(
      page,
      ["qa-planner", "qa-critic", "qa-synthesizer"],
      "群聊停止边界",
    );

    await composer(page).fill("group-long-stream-e2e");
    await sendButton(page).click();
    const stopButton = page.getByRole("button", { name: "中止响应" });
    await expect(stopButton).toBeVisible();
    await page.waitForTimeout(200);
    await stopButton.click();
    await expect.poll(() => composer(page).inputValue(), { timeout: 45_000 }).toBe("");

    expect(await completedAssistantRows(page).count()).toBeLessThan(3);
  });

  test("刷新群聊后可以继续定向发送", async ({ page }) => {
    await createGroup(page, ["qa-planner", "qa-critic"], "刷新后续聊");
    await submitAndWait(page, "@qa-planner group-context-e2e before-reload", 1);
    await expect(completedAssistantRows(page)).toHaveCount(1);

    await page.reload();
    await expect(page.getByText("2 位成员", { exact: true })).toBeVisible();
    await expect(completedAssistantRows(page)).toHaveCount(1);

    await composer(page).fill("@qa-critic group-context-e2e after-reload");
    await sendButton(page).click();
    await expect.poll(() => composer(page).inputValue(), { timeout: 30_000 }).toBe("");
    await expect(
      page.getByText("session not found", { exact: true }),
    ).not.toBeVisible();
    await expect(completedAssistantRows(page)).toHaveCount(2);
    await expect(completedAssistantRows(page).last()).toContainText(
      "agent=qa-critic",
    );
  });
});
