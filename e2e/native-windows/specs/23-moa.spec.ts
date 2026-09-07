import { test, expect, route, api, sendChat, native, baseline } from '../fixtures';

test('MODEL-005 MoA 预设增改删与两路真实参考模型、聚合器执行', async ({ app }, testInfo) => {
  const original = await api(app, '/api/model/moa');
  const name = `e2e-moa-${Date.now()}`;
  const go = async () => { await route(app, '/models'); await app.getByRole('tab', { name: /^MoA 混合/ }).click(); };
  await go();
  await app.getByPlaceholder('如 review、fast').fill(name);
  await app.getByRole('button', { name: '新建预设（克隆当前）', exact: true }).click();
  await expect.poll(async () => Boolean((await api(app, '/api/model/moa')).presets[name])).toBe(true);
  try {
    // Use two independent real DeepSeek calls as references, plus the real
    // DeepSeek aggregator. No other model/provider is authorized for billing.
    while (await app.getByRole('button', { name: '移除', exact: true }).count() > 1)
      await app.getByRole('button', { name: '移除', exact: true }).last().click();
    await app.getByRole('button', { name: '+ 添加参考模型', exact: true }).click();
    const providers = app.getByRole('combobox', { name: '服务商', exact: true });
    await expect(providers).toHaveCount(3);
    for (let i = 0; i < 3; i++) {
      await providers.nth(i).selectOption('deepseek');
      const model = app.getByRole('combobox', { name: '模型', exact: true }).nth(i);
      await model.fill(baseline.model);
      await model.press('Enter');
    }
    await app.getByRole('button', { name: '保存 MoA 配置', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/model/moa')).presets[name].reference_models.map(({ provider, model }: any) => ({ provider, model }))).toEqual([
      { provider: 'deepseek', model: baseline.model }, { provider: 'deepseek', model: baseline.model },
    ]);
    await app.getByRole('button', { name: '设为默认', exact: true }).click();
    await expect.poll(async () => (await api(app, '/api/model/moa')).default_preset).toBe(name);
    await app.reload();
    await app.evaluate(async () => {
      const w = window as any, internal = w.__TAURI_INTERNALS__;
      const observed = { events: [] as any[], eventId: 0 };
      w.__moaAcceptance = observed;
      observed.eventId = await internal.invoke('plugin:event|listen', {
        event: 'gateway-ws-message', target: { kind: 'Any' },
        handler: internal.transformCallback((event: any) => {
          const frame = JSON.parse(event.payload.data);
          if (frame.result?.key === 'model') observed.events.push({ at: Date.now(), response: frame });
        }),
      });
    });
    await go();
    await expect(app.getByRole('combobox').first()).toHaveValue(name);
    await route(app, '/');
    await app.getByRole('button', { name: /^模型 / }).click();
    await app.getByRole('textbox', { name: '搜索模型、平台或能力', exact: true }).fill(name);
    await app.getByRole('button', { name: new RegExp(`切换到 .* 的 ${name}$`) }).click();
    await expect(app.getByRole('dialog', { name: '切换模型', exact: true })).toBeHidden();
    await expect(app.getByRole('button', { name: `模型 ${name}`, exact: true })).toBeVisible();
    const { id, evidence } = await sendChat(app, '请计算 17 乘以 19，最终只回复数字 323，不要调用工具。', '323');
    await expect(app.getByRole('log')).toContainText(/参考|MoA/);
    await route(app, '/debug');
    await app.getByRole('button', { name: '导出 JSON', exact: true }).click();
    const events = JSON.parse((await native({ action: 'clipboard' })).text);
    const references = events.filter((e: any) => e.summary.includes('moa.reference') && JSON.stringify(e.payload).includes(id));
    expect(references).toHaveLength(2);
    for (const ref of references) {
      const serialized = JSON.stringify(ref.payload);
      expect(serialized).toContain(baseline.model);
      expect(serialized).toContain('323');
      expect(serialized).not.toMatch(/error|failed/i);
    }
    await testInfo.attach('moa-reference-events', { body: JSON.stringify(references, null, 2), contentType: 'application/json' });
    await testInfo.attach('moa-aggregator-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
    await go();
    await app.getByRole('combobox').first().selectOption(name);
    await app.getByRole('button', { name: '删除此预设', exact: true }).click();
    await expect.poll(async () => Boolean((await api(app, '/api/model/moa')).presets[name])).toBe(false);
    await route(app, '/');
    await expect(app.getByRole('button', { name: `模型 ${baseline.model}`, exact: true })).toBeVisible();
    const restored = await sendChat(app, '不要使用工具，仅回复 AFTER-MOA-DELETE。', 'AFTER-MOA-DELETE');
    expect(restored.evidence.session.model).toBe(baseline.model);
    expect(restored.evidence.session.billing_provider).toBe(baseline.provider);
    await testInfo.attach('ordinary-chat-after-preset-deletion', { body: JSON.stringify(restored.evidence, null, 2), contentType: 'application/json' });
  } finally {
    const modelChanges = await app.evaluate(async () => {
      const w = window as any, observed = w.__moaAcceptance;
      if (!observed) return [];
      w.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener('gateway-ws-message', observed.eventId);
      await w.__TAURI_INTERNALS__.invoke('plugin:event|unlisten', { event: 'gateway-ws-message', eventId: observed.eventId });
      delete w.__moaAcceptance;
      return observed.events;
    });
    await testInfo.attach('actual-model-switch-rpc', { body: JSON.stringify(modelChanges, null, 2), contentType: 'application/json' });
    // The new-chat picker remembers a session selection independently from
    // the global provider. Restore it before deleting this disposable preset.
    await route(app, '/');
    await app.getByRole('button', { name: /^模型 / }).click();
    const picker = app.getByRole('dialog', { name: '切换模型', exact: true });
    await picker.getByRole('textbox', { name: '搜索模型、平台或能力', exact: true }).fill(baseline.model);
    await picker.getByRole('button', { name: `切换到 DeepSeek 的 ${baseline.model}`, exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(app.getByRole('button', { name: `模型 ${baseline.model}`, exact: true })).toBeVisible();
    await route(app, '/models');
    await app.getByRole('tab', { name: /^主模型/ }).click();
    await app.getByRole('button', { name: /^DeepSeek(?: 当前| 已保存密钥)?$/ }).click();
    const set = app.getByRole('button', { name: '设为当前模型', exact: true });
    if ((await api(app, '/api/model/info')).provider !== 'deepseek') await set.click();
    await go();
    await app.getByRole('combobox').first().selectOption(original.default_preset);
    const setDefault = app.getByRole('button', { name: '设为默认', exact: true });
    if (await setDefault.isEnabled()) await setDefault.click();
    if ((await api(app, '/api/model/moa')).presets[name]) {
      await app.getByRole('combobox').first().selectOption(name);
      await app.getByRole('button', { name: '删除此预设', exact: true }).click();
      await expect.poll(async () => Boolean((await api(app, '/api/model/moa')).presets[name])).toBe(false);
    }
  }
});
