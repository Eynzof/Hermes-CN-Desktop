import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";
import { RUNTIME_DIR } from "../harness/config.mjs";

test("Core restart → resume the same conversation without reloading → switch conversations", async ({ page, request }) => {
  test.setTimeout(90_000);
  const promptSessionIds: string[] = [];
  const resumedSessionIds: string[] = [];
  page.on("websocket", (socket) => {
    const resumeRequests = new Set<string | number>();
    socket.on("framesent", ({ payload }) => {
      const rpc = JSON.parse(String(payload));
      if (rpc.method === "prompt.submit") promptSessionIds.push(rpc.params.session_id);
      if (rpc.method === "session.resume") resumeRequests.add(rpc.id);
    });
    socket.on("framereceived", ({ payload }) => {
      const rpc = JSON.parse(String(payload));
      if (resumeRequests.has(rpc.id) && rpc.result?.session_id) {
        resumedSessionIds.push(rpc.result.session_id);
      }
    });
  });
  const composer = page.getByRole("textbox", { name: "输入消息" });
  const assistantRows = page.getByRole("log").locator('[data-role="assistant"]:has(button[title="朗读回复"])');
  async function send(text: string) {
    await composer.fill(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    await expect(assistantRows.last()).toContainText(text);
    await expect(composer).toHaveValue("");
  }

  await page.goto("/");
  await send("restart-before-one");
  await send("restart-before-two");
  await expect(assistantRows).toHaveCount(2);
  const originalUrl = page.url();
  const previousSessionId = promptSessionIds[0];

  const { url } = JSON.parse(readFileSync(resolve(RUNTIME_DIR, "control.json"), "utf8"));
  const restart = await request.post(`${url}/restart`, { timeout: 45_000 });
  expect(restart.ok()).toBe(true);
  const { previousPid, pid } = await restart.json();
  expect(pid).not.toBe(previousPid);
  await expect.poll(() => resumedSessionIds.length).toBeGreaterThan(0);
  const resumedSessionId = resumedSessionIds.at(-1)!;
  expect(resumedSessionId).not.toBe(previousSessionId);

  await send("restart-after-three");
  expect(promptSessionIds.at(-1)).toBe(resumedSessionId);
  await expect(page).toHaveURL(originalUrl);
  await expect(assistantRows).toHaveCount(3);
  await expect(assistantRows.nth(0)).toContainText("restart-before-one");
  await expect(assistantRows.nth(1)).toContainText("restart-before-two");

  await page.goto("/");
  await send("restart-new-conversation");
  expect(promptSessionIds.at(-1)).not.toBe(resumedSessionId);
  await page.goto(originalUrl);
  await expect(assistantRows).toHaveCount(3);
  await send("restart-return-four");
  await expect(assistantRows).toHaveCount(4);
});
