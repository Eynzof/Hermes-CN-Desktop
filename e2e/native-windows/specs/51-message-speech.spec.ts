import { test, expect, chat, route } from '../fixtures';

test('VOICE-004 真实模型回复手动及自动朗读、实际音频播放和停止', async ({ app }, testInfo) => {
  const verifyPlayback = async (phase: string) => {
    const button = app.getByRole('log').locator('button[data-speech-state]').last();
    let error: string[] = [];
    await expect.poll(async () => {
      error = await app.locator('[class*="messageSpeechError"]').allTextContents();
      return error.length > 0 || await button.getAttribute('data-speech-state') === 'speaking';
    }, { timeout: 60_000 }).toBe(true);
    await testInfo.attach(`${phase}-speech-ui`, { body: await app.screenshot(), contentType: 'image/png' });
    expect.soft(error, `${phase} must synthesize and play actual audio`).toEqual([]);
    if (error.length) return;
    const cdp = await app.context().newCDPSession(app);
    try {
      const prototype = await cdp.send('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
      const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId! });
      const readAudio = async () => (await cdp.send('Runtime.callFunctionOn', {
        objectId: objects.objects.objectId,
        functionDeclaration: 'function(){return this.map(a=>({duration:a.duration,currentTime:a.currentTime,paused:a.paused,audioData:a.src.startsWith("data:audio/"),sourceBytes:a.src.length}))}',
        returnByValue: true,
      })).result.value;
      const playing = await readAudio();
      expect(playing.some((a: any) => a.audioData && !a.paused && a.duration > 0 && a.sourceBytes > 1000)).toBe(true);
      await expect(button).toHaveAttribute('title', '停止朗读');
      await button.click();
      await expect(button).toHaveAttribute('data-speech-state', 'idle');
      const stopped = await readAudio();
      expect(stopped.every((a: any) => a.paused)).toBe(true);
      await testInfo.attach(`${phase}-actual-audio`, { body: JSON.stringify({ playing, stopped }, null, 2), contentType: 'application/json' });
    } finally { await cdp.detach(); }
  };
  await route(app, '/voice');
  await app.getByRole('button', { name: /^Edge TTS 无需密钥/ }).click();
  const voice = app.getByRole('textbox', { name: 'Edge 语音', exact: true });
  const originalVoice = await voice.inputValue();
  const toggle = app.getByRole('button', { name: '自动朗读助手回复', exact: true });
  const original = await toggle.getAttribute('data-on') === 'true';
  try {
    await voice.fill('zh-CN-XiaoxiaoNeural');
    if (original) await toggle.click();
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
    await chat(app, '不要调用工具。请原样回复：你好，这是社区桌面版的真实语音朗读测试，我们正在验证声音播放和停止按钮。', '真实语音朗读测试');
    const button = app.getByRole('log').locator('button[data-speech-state]').last();
    await expect(button).toHaveAttribute('data-speech-state', 'idle');
    await button.click();
    await verifyPlayback('manual');
    await route(app, '/voice');
    await toggle.click();
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
    await chat(app, '不要调用工具。请原样回复：这是一条新的助手消息，需要自动朗读，我们正在验证自动播放和停止按钮。', '验证自动播放');
    await verifyPlayback('automatic');
  } finally {
    await route(app, '/voice');
    await voice.fill(originalVoice);
    if ((await toggle.getAttribute('data-on') === 'true') !== original) await toggle.click();
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
  }
});
