import { test, expect, route, api, chat } from '../fixtures';

test('SOUL-002 人格市场搜索、筛选、预览、取消覆盖、应用及真实身份', async ({ app }, testInfo) => {
  const original = (await api(app, '/api/profiles/default/soul')).content;
  await route(app, '/soul');
  const search = app.getByRole('textbox', { name: '搜索人格' });
  await search.fill('no-matching-persona-unique');
  await expect(app.getByText('没有匹配的人格，换个关键词试试。', { exact: true })).toBeVisible();
  await app.getByRole('button', { name: '重置筛选', exact: true }).click();
  await app.getByRole('button', { name: /^查看更多/ }).click();
  await app.getByRole('combobox', { name: '领域' }).selectOption('security');
  await search.fill('合规审计师');
  await expect(app.getByText('找到 1 个匹配人格', { exact: true })).toBeVisible();
  await app.getByRole('button').filter({ hasText: '合规审计师' }).click();
  const detail = app.getByRole('dialog', { name: '合规审计师', exact: true });
  await expect(detail.getByRole('button', { name: '立即应用', exact: true })).toBeEnabled();
  await expect(detail).toContainText('SOC 2');
  try {
    await detail.getByRole('button', { name: '立即应用', exact: true }).click();
    const confirm = app.getByRole('dialog', { name: '覆盖当前人格？', exact: true });
    await confirm.getByRole('button', { name: '取消', exact: true }).click();
    expect((await api(app, '/api/profiles/default/soul')).content).toBe(original);
    await detail.getByRole('button', { name: '立即应用', exact: true }).click();
    await confirm.getByRole('button', { name: '确认覆盖并应用', exact: true }).click();
    await expect(detail).toContainText('已应用到档案 default');
    const applied = (await api(app, '/api/profiles/default/soul')).content;
    expect(applied).toContain('合规审计师');
    expect(applied).toContain('SOC 2');
    await detail.getByRole('button', { name: '关闭人格详情', exact: true }).click();
    await app.reload();
    await app.getByRole('tab', { name: 'Hermes 人格', exact: true }).click();
    await expect(app.getByRole('textbox')).toHaveValue(applied);
    const { evidence } = await chat(app, '请用一句话介绍你当前的专业身份，不要使用工具。', /合规|审计/);
    await testInfo.attach('market-persona-session', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally {
    if (await detail.isVisible()) await detail.getByRole('button', { name: '关闭人格详情', exact: true }).click();
    await route(app, '/soul');
    await app.getByRole('tab', { name: 'Hermes 人格', exact: true }).click();
    await app.getByRole('textbox').fill(original);
    const save = app.getByRole('button', { name: '保存人格', exact: true });
    if (await save.isEnabled()) await save.click();
    await expect.poll(async () => (await api(app, '/api/profiles/default/soul')).content).toBe(original);
  }
});
