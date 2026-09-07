import { readFileSync, writeFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { PNG } from 'pngjs';
import { test, expect, route, api, sendChat, chat, nativeDialog, root, baseline, sessionEvidence } from '../fixtures';

test('CHAT-013 原生像素识别及官方主模型调用本地辅助视觉', async ({ app }, info) => {
  test.setTimeout(1_200_000);
  execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'prepare-local-model.ps1'), '-Root', root, '-Vision'], { encoding: 'utf8', windowsHide: true, timeout: 1_000_000 });
  const fixture = JSON.parse(readFileSync(path.join(root, 'reports', 'local-vision-fixture.json'), 'utf8').replace(/^\uFEFF/, ''));
  await info.attach('local-vision-model-provenance', { body: JSON.stringify(fixture, null, 2), contentType: 'application/json' });
  const before = await api(app, '/api/config');
  expect(before.auxiliary?.vision?.provider || 'auto', 'Use the isolated unconfigured vision slot').toBe('auto');
  const originalMode = before.agent?.image_input_mode || 'auto';
  const originalContext = Number(before.model_context_length || 0);
  const name = `E2E Vision ${Date.now()}`;
  const startedAt = new Date().toISOString();
  const mainModels = async () => { await route(app, '/models'); await app.getByRole('tab', { name: /^主模型/ }).click(); };
  const auxiliary = async () => { await route(app, '/models'); await app.getByRole('tab', { name: /^辅助模型/ }).click(); };
  const useDeepSeek = async () => {
    await mainModels();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    await app.getByRole('textbox', { name: '上下文窗口', exact: true }).fill(originalContext ? String(originalContext) : '');
    if ((await api(app, '/api/model/info')).provider !== 'deepseek') await app.getByRole('button', { name: '设为当前模型', exact: true }).click();
    else if (Number((await api(app, '/api/config')).model_context_length || 0) !== originalContext) await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/model/info')).model).toBe(baseline.model);
    await expect.poll(async () => Number((await api(app, '/api/config')).model_context_length || 0)).toBe(originalContext);
  };
  const imageMode = async (mode: string) => {
    await auxiliary();
    await app.getByRole('combobox').first().selectOption(mode);
    await expect.poll(async () => (await api(app, '/api/config')).agent?.image_input_mode).toBe(mode);
  };
  let previousColors = '';
  const picture = () => {
    const palette = [{ name: 'red', rgb: [230, 20, 30] }, { name: 'blue', rgb: [20, 70, 230] }, { name: 'green', rgb: [20, 170, 60] }, { name: 'yellow', rgb: [245, 210, 20] }];
    for (let i = palette.length - 1; i > 0; i--) { const j = randomInt(i + 1); [palette[i], palette[j]] = [palette[j], palette[i]]; }
    if (palette.map(item => item.name).join(',') === previousColors) palette.push(palette.shift()!);
    previousColors = palette.map(item => item.name).join(',');
    const png = new PNG({ width: 320, height: 320 });
    png.data.fill(255);
    for (let y = 16; y < 304; y++) for (let x = 16; x < 304; x++) {
      if ((x >= 152 && x < 168) || (y >= 152 && y < 168)) continue;
      const index = (y >= 168 ? 2 : 0) + (x >= 168 ? 1 : 0);
      const offset = (y * 320 + x) * 4;
      palette[index].rgb.forEach((v, channel) => { png.data[offset + channel] = v; });
    }
    const file = path.join(root, 'workspace', randomUUID() + '.png');
    writeFileSync(file, PNG.sync.write(png));
    return { file, expected: palette.map(item => item.name) };
  };
  const recognize = async (mode: 'native' | 'auxiliary', stage: string) => {
    const input = picture();
    await info.attach(stage + '-actual-pixels', { path: input.file, contentType: 'image/png' });
    await info.attach(stage + '-expected-colors', { body: JSON.stringify(input), contentType: 'application/json' });
    await route(app, '/');
    await app.getByRole('button', { name: '添加附件', exact: true }).click();
    await nativeDialog('选择附件', input.file, '%o');
    await expect(app.locator('[data-kind="image"][data-status="ready"]')).toHaveCount(1);
    const method = mode === 'native'
      ? 'Read the attached image directly. Do not use any tools.'
      : 'Use vision_analyze exactly once to inspect the attached image. Do not use terminal, file reading, code, OCR or any other tools.';
    const prompt = `${method} The image has four large colored squares with white gutters. Reply with only the four basic English color names in this order: top-left, top-right, bottom-left, bottom-right. Ignore the white background.`;
    // Stop a failed native attempt once it issues a tool, rather than leaving
    // an image-less small model wandering through unrelated tools for minutes.
    // This is an observed failure, never a retry or a synthetic model result.
    let settled = false;
    let forbiddenTool = '';
    const attempt = sendChat(app, prompt, /red|blue|green|yellow|红色|紅色|蓝色|藍色|绿色|綠色|黄色|黃色/i, undefined, 600_000)
      .then(value => ({ value, error: undefined }), error => ({ value: undefined, error }))
      .finally(() => { settled = true; });
    try {
      while (!settled) {
        if (mode === 'native' && app.url().includes('#/tasks/')) {
          const id = decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]);
          const evidence = sessionEvidence(id);
          const tool = evidence.messages.find((message: any) => message.role === 'assistant' && message.tool_calls);
          if (tool) {
            forbiddenTool = JSON.parse(tool.tool_calls)[0]?.function?.name || 'unknown';
            await info.attach('native-forbidden-tool-before-stop', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
            const stop = app.getByRole('button', { name: '中止响应', exact: true });
            if (await stop.isVisible()) await stop.click();
            break;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } finally {
      // Join the actual submitted turn before the next phase changes models.
      await attempt;
    }
    const outcome = await attempt;
    if (forbiddenTool) throw new Error(`Native pixel recognition issued forbidden tool ${forbiddenTool}; stopped through the actual UI. Inspect the persisted session and service logs for image routing.`);
    if (outcome.error) throw outcome.error;
    const result = outcome.value!;
    await info.attach(stage + '-real-session', { body: JSON.stringify(result.evidence, null, 2), contentType: 'application/json' });
    const answer = result.evidence.messages.filter((m: any) => m.role === 'assistant').at(-1).content;
    expect(result.evidence.session.model).toBe(mode === 'native' ? fixture.model : baseline.model);
    expect(result.evidence.session.billing_base_url).toBe(mode === 'native' ? fixture.origin + '/v1' : baseline.baseUrl);
    // The community persona may answer in Chinese. Normalize only equivalent
    // color names; the four actual pixel positions remain the assertion.
    const aliases: Record<string, string> = { crimson: 'red', 红色: 'red', 紅色: 'red', 蓝色: 'blue', 藍色: 'blue', 绿色: 'green', 綠色: 'green', 黄色: 'yellow', 黃色: 'yellow' };
    const colors = answer.toLowerCase().match(/\b(red|crimson|blue|green|yellow)\b|红色|紅色|蓝色|藍色|绿色|綠色|黄色|黃色/g)
      ?.map((color: string) => aliases[color] || color);
    expect(colors).toEqual(input.expected);
    const toolResults = result.evidence.messages.filter((m: any) => m.role === 'tool');
    if (mode === 'native') expect(toolResults).toHaveLength(0);
    else expect(toolResults.map((m: any) => m.tool_name)).toEqual(['vision_analyze']);
    await info.attach(stage + '-rendered-answer', { body: await app.screenshot(), contentType: 'image/png' });
  };
  let added = false;
  let provider = '';
  let auxiliaryFailed = false;
  try {
    await mainModels();
    await app.getByRole('button', { name: '本地部署', exact: true }).click();
    const dialog = app.getByRole('dialog', { name: '添加本地部署服务商', exact: true });
    await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name);
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.origin + '/v1');
    await dialog.getByRole('combobox', { name: '默认模型', exact: true }).fill(fixture.model);
    await dialog.getByRole('combobox', { name: '默认模型', exact: true }).press('Enter');
    await dialog.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('65536');
    await dialog.getByRole('button', { name: '添加并选中', exact: true }).click();
    added = true;
    await expect(dialog).toBeHidden();
    provider = (await api(app, '/api/model/info')).provider;
    expect(provider).toMatch(/^custom:127-0-0-1-11435/);
    const entries = (await api(app, '/api/config')).providers;
    const entry = entries[provider] || entries[provider.replace(/^custom:/, '')];
    expect(entry, 'Read the saved provider from the actual v0.21 providers mapping').toBeTruthy();
    await info.attach('saved-local-provider-metadata', { body: JSON.stringify(Object.fromEntries(Object.entries(entry).filter(([key]) => ['name', 'base_url', 'model', 'default_model', 'models', 'api_mode', 'api_type', 'type'].includes(key))), null, 2), contentType: 'application/json' });
    for (const stage of ['native', 'auxiliary', 'auxiliary-after-ttl', 'auxiliary-after-resave'] as const) {
      if (stage.startsWith('auxiliary-after-') && !auxiliaryFailed) continue;
      const mode = stage === 'native' ? 'native' : 'auxiliary';
      try {
        if (stage === 'native') await imageMode('native');
        else if (stage === 'auxiliary') {
          await useDeepSeek();
          await imageMode('text');
          await app.getByRole('button', { name: /^视觉分析 / }).click();
          await app.getByRole('combobox', { name: '服务商', exact: true }).selectOption(provider);
          await app.getByRole('combobox', { name: '模型', exact: true }).fill(fixture.model);
          await app.getByRole('combobox', { name: '模型', exact: true }).press('Enter');
          await app.getByRole('textbox', { name: '调用超时（秒）', exact: true }).fill('300');
          await app.getByRole('button', { name: '保存此辅助任务', exact: true }).click();
          await expect.poll(async () => (await api(app, '/api/config')).auxiliary?.vision?.model).toBe(fixture.model);
        } else if (stage === 'auxiliary-after-ttl') {
          // A distinct cache-expiry scenario, preserving the immediate failure.
          // registry.py caches tool availability for 30s; use actual wall time.
          const started = Date.now();
          await new Promise(resolve => setTimeout(resolve, 35_000));
          await info.attach('tool-cache-expiry-wait', { body: JSON.stringify({ started, finished: Date.now(), expectedTtlMs: 30_000 }), contentType: 'application/json' });
        } else {
          // model_tools.py also memoizes definitions by config mtime. Test an
          // explicit UI re-save after expiry, not a hidden cache invalidation.
          await auxiliary();
          await app.getByRole('button', { name: /^视觉分析 / }).click();
          await app.getByRole('textbox', { name: '调用超时（秒）', exact: true }).fill('301');
          await app.getByRole('button', { name: '保存此辅助任务', exact: true }).click();
          await expect.poll(async () => (await api(app, '/api/config')).auxiliary?.vision?.timeout).toBe(301);
        }
        // Verify saved configuration after a real WebView reload. Prior runs
        // separately retain the stale model/picker/tool inventory without it.
        await app.reload();
        await app.waitForFunction(() => (window as any).__HERMES_RUNTIME__?.backendReady && typeof (window as any).hermesDesktop?.request === 'function');
        await expect.poll(async () => (await api(app, '/api/model/info')).model).toBe(mode === 'native' ? fixture.model : baseline.model);
        await expect.poll(async () => (await api(app, '/api/config')).agent?.image_input_mode).toBe(mode === 'native' ? 'native' : 'text');
        await recognize(mode, stage);
      } catch (error) {
        if (stage === 'auxiliary') auxiliaryFailed = true;
        if (app.url().includes('#/tasks/')) {
          const evidence = sessionEvidence(decodeURIComponent(app.url().split('#/tasks/')[1].split('?')[0]));
          await info.attach(stage + '-failed-real-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
          if (mode === 'native' && evidence.session?.model === fixture.model) {
            const label = await app.getByRole('button', { name: /^模型 / }).textContent();
            await info.attach('native-actual-model-vs-display', { body: JSON.stringify({ persistedModel: evidence.session.model, label }), contentType: 'application/json' });
            expect.soft(label, 'Session model display must match actual local inference').toContain(fixture.model);
          }
        }
        await info.attach(stage + '-failure', { body: String(error), contentType: 'text/plain' });
        await info.attach(stage + '-failure-ui', { body: await app.screenshot(), contentType: 'image/png' });
        expect.soft(error, stage + ' real visual recognition').toBeUndefined();
        const stop = app.getByRole('button', { name: '中止响应', exact: true });
        if (await stop.isVisible()) { await stop.click(); await expect(stop).toHaveCount(0, { timeout: 30_000 }); }
      }
    }
  } finally {
    await imageMode(originalMode);
    await app.getByRole('button', { name: /^视觉分析 / }).click();
    await app.getByRole('button', { name: '恢复为自动', exact: true }).click();
    await useDeepSeek();
    if (added) {
      await app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) }).click();
      await app.getByRole('button', { name: '删除服务商', exact: true }).click();
      await app.getByRole('dialog', { name: '删除服务商', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
      await expect(app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) })).toHaveCount(0);
      const remaining = (await api(app, '/api/config')).providers;
      expect(remaining[provider] || remaining[provider.replace(/^custom:/, '')]).toBeUndefined();
    }
    const restored = await chat(app, '不要调用工具，只回复 VISION-TEST-RESTORED。', 'VISION-TEST-RESTORED');
    expect(restored.evidence.session.model).toBe(baseline.model);
    await info.attach('restored-main-model-context', { body: JSON.stringify({ originalContext, restoredContext: (await api(app, '/api/config')).model_context_length }), contentType: 'application/json' });
    await info.attach('restored-official-model', { body: JSON.stringify(restored.evidence, null, 2), contentType: 'application/json' });
    const logs = spawnSync('docker', ['logs', '--since', startedAt, fixture.container], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    await info.attach('real-local-vision-service-log', { body: (logs.stdout || '') + (logs.stderr || ''), contentType: 'text/plain' });
  }
});
