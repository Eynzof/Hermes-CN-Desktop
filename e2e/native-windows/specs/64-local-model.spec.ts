import { readFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test, expect, route, api, chat, sendChat, baseline, root } from '../fixtures';

test('MODEL-009 本地部署模型发现、无密钥探测、64K 真实推理与切回官方模型', async ({ app }, info) => {
  test.setTimeout(900_000);
  const prepared = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'native-windows', 'scripts', 'prepare-local-model.ps1'), '-Root', root], { encoding: 'utf8', windowsHide: true, timeout: 1_200_000 });
  const fixture = JSON.parse(readFileSync(path.join(root, 'reports', 'local-model-fixture.json'), 'utf8').replace(/^\uFEFF/, ''));
  await info.attach('real-local-model-provenance', { body: JSON.stringify({ prepared, fixture }, null, 2), contentType: 'application/json' });
  const name = `E2E Local ${Date.now()}`;
  const startedAt = new Date().toISOString();
  const goModels = async () => { await route(app, '/models'); await app.getByRole('tab', { name: /^主模型/ }).click(); };
  const dialog = app.getByRole('dialog', { name: '添加本地部署服务商', exact: true });
  let added = false;
  try {
  await goModels();
  await app.getByRole('button', { name: '本地部署', exact: true }).click();
  await dialog.getByRole('button', { name: /^Ollama/ }).click();
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name);
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(fixture.origin + '/v1');
  await expect(dialog.getByRole('textbox', { name: 'API Key', exact: true })).toHaveValue('');
  await dialog.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('4096');
  await expect(dialog.getByRole('alert')).toContainText('64,000');
  await dialog.getByRole('textbox', { name: '上下文窗口', exact: true }).fill('65536');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await dialog.getByTitle('从服务商读取模型列表', { exact: true }).click();
  await expect(dialog.getByRole('button', { name: /^已加载 \d+ 个$/ })).toBeVisible();
  const model = dialog.getByRole('combobox', { name: '默认模型', exact: true });
  await model.fill(fixture.model);
  // The combobox renders its actual options in a separate body portal.
  await expect(app.getByRole('option', { name: fixture.model, exact: true })).toBeVisible();
  await app.getByRole('option', { name: fixture.model, exact: true }).click();
  await info.attach('native-local-provider-form', { body: await app.screenshot(), contentType: 'image/png' });
  await dialog.getByRole('button', { name: '添加并选中', exact: true }).click();
  added = true;
  await expect(dialog).toBeHidden();
    await app.getByRole('button', { name: '测试连接', exact: true }).click();
    const connected = app.getByText(/✓ 连接成功 · 延迟/);
    const rejected = app.getByText(/✗.*API Key 被拒绝/);
    await expect(connected.or(rejected)).toBeVisible({ timeout: 180_000 });
    await info.attach('keyless-local-probe', { body: await app.screenshot(), contentType: 'image/png' });
    // A broken connection probe need not prevent the independent actual chat.
    expect.soft(await connected.isVisible(), 'The local deployment form explicitly permits an empty API Key').toBe(true);
    await app.reload();
    await goModels();
    await app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) }).click();
    await expect(app.getByRole('textbox', { name: '上下文窗口', exact: true })).toHaveValue('65536');
    const selected = await api(app, '/api/model/info');
    expect(selected.model).toBe(fixture.model);
    expect(selected.provider).toMatch(/^custom:127-0-0-1-11435/);
    expect(selected.effective_context_length).toBe(65536);
    await route(app, '/');
    await app.getByRole('button', { name: /^思考 / }).click();
    await app.getByRole('menuitemradio', { name: '关闭思考', exact: true }).click();
    const response = await sendChat(app, 'This is a local inference test. Do not call any tools. Reply with exactly LOCAL-MODEL-READY and nothing else.', 'LOCAL-MODEL-READY', undefined, 600_000);
    expect(response.evidence.session.model).toBe(fixture.model);
    expect(response.evidence.session.billing_base_url).toBe(fixture.origin + '/v1');
    expect(response.evidence.session.input_tokens).toBeGreaterThan(0);
    expect(response.evidence.session.output_tokens).toBeGreaterThan(0);
    expect(response.evidence.session.tool_call_count).toBe(0);
    const loaded = await (await fetch(fixture.origin + '/api/ps')).json();
    expect(loaded.models.find((item: any) => item.name === fixture.model)?.context_length).toBe(65536);
    await info.attach('actual-local-inference', { body: JSON.stringify({ selected, loaded, evidence: response.evidence }, null, 2), contentType: 'application/json' });
  } catch (error) {
    await info.attach('local-primary-error', { body: String(error), contentType: 'text/plain' });
    throw error;
  } finally {
    const logs = spawnSync('docker', ['logs', '--since', startedAt, fixture.container], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    await info.attach('real-ollama-service-log', { body: (logs.stdout || '') + (logs.stderr || ''), contentType: 'text/plain' });
    await info.attach('local-ui-before-restore', { body: await app.screenshot(), contentType: 'image/png' });
    if (await dialog.isVisible()) {
      await dialog.getByRole('button', { name: '取消', exact: true }).click();
    }
    if (added) {
    await goModels();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    if ((await api(app, '/api/model/info')).provider !== 'deepseek') await app.getByRole('button', { name: '设为当前模型', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/model/info')).model).toBe(baseline.model);
    await app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) }).click();
    await app.getByRole('button', { name: '删除服务商', exact: true }).click();
    await app.getByRole('dialog', { name: '删除服务商', exact: true }).getByRole('button', { name: '删除', exact: true }).click();
    await expect(app.getByRole('button', { name: new RegExp(`^${name}(?: 当前| 已保存密钥)?$`) })).toHaveCount(0);
    const restored = await chat(app, '不要调用工具，只回复 DEEPSEEK-RESTORED。', 'DEEPSEEK-RESTORED');
    expect(restored.evidence.session.model).toBe(baseline.model);
    expect(restored.evidence.session.billing_base_url).toBe(baseline.baseUrl);
    await info.attach('restored-official-deepseek', { body: JSON.stringify(restored.evidence, null, 2), contentType: 'application/json' });
    }
    expect((await api(app, '/api/model/info')).model).toBe(baseline.model);
  }
});
