import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, route, chat, bridge, native, root, deepseekKey, api } from '../fixtures';

test('CODE-001 编程 Agent 实际检测、技能开关、Claude Code 委派与真实生成代码', async ({ app }, testInfo) => {
  test.setTimeout(300_000);
  const marker = `coding-${Date.now()}`;
  const folder = path.join(root, 'workspace', marker);
  const privateConfig = path.join(root, 'secrets', 'claude', marker);
  mkdirSync(folder, { recursive: true });
  mkdirSync(privateConfig, { recursive: true });
  const model = 'deepseek-v4-flash';
  // Official Claude Code runs against DeepSeek's real Anthropic-compatible
  // API. Its configuration is isolated from the user's own Claude account.
  writeFileSync(path.join(privateConfig, 'settings.json'), JSON.stringify({ env: {
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: deepseekKey(), ANTHROPIC_API_KEY: '',
    ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  } }, null, 2));
  const code = path.join(folder, 'add.cjs');
  const transcript = path.join(folder, 'claude-stream.jsonl');
  await route(app, '/coding-agents');
  await app.getByRole('button', { name: '刷新检测', exact: true }).click();
  const check = await bridge<any>(app, 'codingAgentsCheck');
  const claude = check.agents.find((agent: any) => agent.id === 'claude-code');
  expect(claude.installed, 'The actual Claude Code CLI is required for this workflow').toBe(true);
  expect(existsSync(claude.path)).toBe(true);
  const card = app.locator('[data-coding-agent-card]').filter({ has: app.getByRole('heading', { name: 'Claude Code', exact: true }) });
  await expect(card).toContainText(claude.version);
  await expect(card).toContainText(claude.path);
  await app.getByRole('button', { name: '复制诊断 JSON', exact: true }).click();
  expect(JSON.parse((await native({ action: 'clipboard' })).text).codingAgents.agents).toEqual(check.agents);
  const skill = card.getByRole('group', { name: 'Claude Code 委派技能', exact: true });
  const wasEnabled = await skill.getAttribute('data-state') === 'enabled';
  try {
    if (wasEnabled) await skill.getByRole('button', { name: '停用技能', exact: true }).click();
    await expect(skill).toHaveAttribute('data-state', 'disabled');
    await skill.getByRole('button', { name: '启用技能', exact: true }).click();
    await expect(skill).toHaveAttribute('data-state', 'enabled');
    await expect.poll(async () => (await api(app, '/api/skills')).find((s: any) => s.name === 'claude-code')?.enabled).toBe(true);
    const command = `CLAUDE_CONFIG_DIR='${privateConfig.replaceAll('\\', '/')}' CLAUDE_CODE_GIT_BASH_PATH='C:/Users/admin/Desktop/Dev/Git/bin/bash.exe' claude -p 'Create add.cjs in the current directory. Export a function add(a,b) that returns a+b using exports.add. Add a comment ${marker}. Only write this file, do not spawn agents or access other folders. Reply CODE-CREATED.' --model ${model} --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools 'Read,Write,Edit' --max-turns 4 > '${transcript.replaceAll('\\', '/')}' && cat '${transcript.replaceAll('\\', '/')}'`;
    const result = await chat(app, `这是编程 Agent 委派测试。先用 skill_view 读取 claude-code 技能，然后调用 terminal 原样执行下面的 Git Bash 命令（此 Windows 上 terminal 工具实际使用 Git Bash），workdir 必须是 ${folder.replaceAll('\\', '/')}，timeout=180，前台执行。不要转换成 cmd 或 PowerShell；不要自己编写、修改文件，不要读取密钥或 CLI 配置文件；只能由真实 Claude Code 创建 add.cjs。命令：\n${command}\n确认子进程成功后只回复 DELEGATION-COMPLETE。若命令失败则立即报告，不要自行修改命令反复尝试。`, 'DELEGATION-COMPLETE', 240_000);
    expect(readFileSync(code, 'utf8')).toContain(marker);
    const output = execFileSync(process.execPath, ['-e', 'const m=require(process.argv[1]); process.stdout.write(JSON.stringify([m.add(17,25),m.add(-5,2)]));', code], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([42, -3]);
    const events = readFileSync(transcript, 'utf8').split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
    const cliResult = events.findLast((event: any) => event.type === 'result');
    expect(cliResult?.is_error).toBe(false);
    expect(cliResult?.usage?.output_tokens).toBeGreaterThan(0);
    expect(Object.keys(cliResult.modelUsage)).toEqual([model]);
    expect(events.some((event: any) => event.type === 'assistant' && event.message?.content?.some((part: any) => part.type === 'tool_use' && part.name === 'Write' && part.input?.file_path?.replaceAll('\\', '/').endsWith('/add.cjs')))).toBe(true);
    expect(result.evidence.messages.some((m: any) => m.role === 'tool' && /^(write_file|file_write|apply_patch|patch)$/.test(m.tool_name))).toBe(false);
    const delegation = app.locator('div[data-agent="claude-code"][data-status]').last();
    await expect(delegation).toHaveAttribute('data-status', 'completed');
    if (await delegation.locator('button[data-open]').getAttribute('data-open') !== 'true') await delegation.locator('button[data-open]').click();
    await expect(delegation).toContainText(cliResult.session_id);
    await delegation.getByRole('button', { name: '复制会话 ID', exact: true }).click();
    expect((await native({ action: 'clipboard' })).text).toBe(cliResult.session_id);
    await testInfo.attach('real-coding-agent-evidence', { body: JSON.stringify({ detected: check, generatedCode: readFileSync(code, 'utf8'), codeResults: JSON.parse(output), cliEvents: events, hermes: result.evidence }, null, 2).replaceAll(deepseekKey(), '[REDACTED_SECRET]'), contentType: 'application/json' });
  } finally {
    const stop = app.getByRole('button', { name: '中止响应', exact: true });
    if (await stop.isVisible()) { await stop.click(); await expect(stop).toBeHidden({ timeout: 30_000 }); }
    await route(app, '/coding-agents');
    await expect(skill).toBeVisible();
    const enabled = await skill.getAttribute('data-state') === 'enabled';
    if (enabled !== wasEnabled) await skill.getByRole('button', { name: wasEnabled ? '启用技能' : '停用技能', exact: true }).click();
  }
});
