import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, chat, sendChat, root, sessionEvidence } from '../fixtures';

test('CHAT-010 真实子 Agent 委派、监视、追加指令、停止及清空记录', async ({ app }, testInfo) => {
  test.setTimeout(240_000);
  const marker = `child-${Date.now()}`;
  const file = path.join(root, 'workspace', marker + '.txt');
  const stoppedFile = path.join(root, 'workspace', marker + '-stopped.txt');
  const goal = `STEER-${marker}：先用 terminal 同步执行 powershell -NoProfile -Command Start-Sleep -Seconds 25，然后按最新收到的指令用文件写入工具创建 ${file.replaceAll('\\', '/')}，默认内容 ORIGINAL。只操作该文件。`;
  const panel = app.getByRole('complementary', { name: '子Agent 监视', exact: true });
  try {
  const parent = await chat(app, `本次测试需要真实子 Agent。请调用 delegate_task，tasks 中仅包含一个子任务，goal 完整填写：${goal}。沿用当前 deepseek-v4-flash 模型。派发后本回合不要等待、不要反复查询，立即只回复 CHILD-SPAWNED。随后我会通过桌面的追加指令按钮直接更新子任务要求，这是已授权的用户操作。后续收到子任务完成通知时，不要核查文件或转录，只回复 CHILD-COMPLETED。`, 'CHILD-SPAWNED');
  await app.getByRole('button', { name: '子Agent 监视', exact: true }).click();
  const child = panel.locator('[data-subagent-id]').filter({ hasText: `STEER-${marker}` });
  await expect(child.getByRole('button', { name: '追加指令', exact: true })).toBeVisible();
  await child.getByRole('button', { name: '追加指令', exact: true }).click();
  await child.getByRole('textbox', { name: '子任务追加指令' }).fill(`更新要求：文件 ${file.replaceAll('\\', '/')} 的内容必须改为 STEERED-${marker}，不能写 ORIGINAL。完成后回复同一标记。`);
  await child.getByRole('button', { name: '发送指令', exact: true }).click();
  await expect(child).toContainText('指令已排队');
  await expect.poll(() => existsSync(file) ? readFileSync(file, 'utf8').trim() : '', { timeout: 90_000 }).toBe(`STEERED-${marker}`);
  await expect(child).not.toHaveAttribute('data-running', 'true', { timeout: 90_000 });
  await expect(child).toContainText('deepseek-v4-flash');
  await testInfo.attach('completed-subagent-ui', { body: await panel.ariaSnapshot(), contentType: 'text/plain' });
  // Child completion resumes the parent automatically. Finish that real
  // background turn before expecting the ordinary send button again.
  await expect(app.getByRole('log').getByText('CHILD-COMPLETED', { exact: true })).toBeVisible({ timeout: 90_000 });
  await expect(app.getByRole('button', { name: '中止响应', exact: true })).toBeHidden({ timeout: 90_000 });
  await sendChat(app, `再调用 delegate_task 派发一个子 Agent，沿用 deepseek-v4-flash，goal 为“STOP-${marker}：首先使用 terminal 同步运行 powershell -NoProfile -Command Start-Sleep -Seconds 60，timeout=90，不能后台执行。等待结束后创建文件 ${stoppedFile.replaceAll('\\', '/')}，内容为 SHOULD-NOT-EXIST。” 派发后立即仅回复 SECOND-SPAWNED，不要等待或查询。`, 'SECOND-SPAWNED');
  const stopping = panel.locator('[data-subagent-id]').filter({ hasText: `STOP-${marker}` });
  await stopping.getByRole('button', { name: '停止子任务', exact: true }).click();
  await expect(stopping).toContainText(/已请求停止|正在停止/);
  await expect(stopping).not.toHaveAttribute('data-running', 'true', { timeout: 90_000 });
  expect(existsSync(stoppedFile)).toBe(false);
  const evidence = sessionEvidence(parent.id);
  expect(evidence.children.length).toBeGreaterThanOrEqual(2);
  expect(evidence.children.every((item: any) => item.model === 'deepseek-v4-flash')).toBe(true);
  expect(evidence.children.some((item: any) => item.output_tokens > 0 && item.billing_provider === 'deepseek')).toBe(true);
  await testInfo.attach('subagent-lineage', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  await panel.getByRole('button', { name: '清空已结束', exact: true }).click();
  await expect(panel).toContainText('暂无子Agent 活动');
  await panel.getByRole('button', { name: '关闭子Agent 监视', exact: true }).click();
  await expect(panel).toHaveCount(0);
  } finally {
    if (!app.isClosed()) {
      const toggle = app.getByRole('button', { name: '子Agent 监视', exact: true });
      if (!await panel.isVisible() && await toggle.isVisible()) await toggle.click();
      if (await panel.isVisible()) {
        const own = panel.locator('[data-subagent-id][data-running="true"]').filter({ hasText: marker });
        for (const child of await own.all()) {
          const stop = child.getByRole('button', { name: '停止子任务', exact: true });
          if (await stop.isVisible()) await stop.click();
        }
        await expect(own, "Only this workflow's child agents must finish before the next case").toHaveCount(0, { timeout: 60_000 });
        await panel.getByRole('button', { name: '关闭子Agent 监视', exact: true }).click();
      }
      const stop = app.getByRole('button', { name: '中止响应', exact: true });
      if (await stop.isVisible()) { await stop.click(); await expect(stop).toBeHidden({ timeout: 30_000 }); }
    }
  }

});
