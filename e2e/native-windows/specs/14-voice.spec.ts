import { test, expect, route, api } from '../fixtures';

test('VOICE-001 语音供应商表单、参数保存和重新加载', async ({ app }, testInfo) => {
  await route(app, '/voice');
  await expect(app.getByRole('button', { name: '保存配置', exact: true })).toBeEnabled();
  const originalVoice = await app.getByRole('textbox', { name: 'Edge 语音', exact: true }).inputValue();
  const originalDuration = await app.getByRole('spinbutton', { name: '最长录音时长' }).inputValue();
  await app.getByRole('button', { name: /^OpenAI TTS 需要/ }).click();
  await expect(app.getByText('VOICE_TOOLS_OPENAI_KEY', { exact: true }).first()).toBeVisible();
  await app.getByRole('button', { name: /^Edge TTS 无需密钥/ }).click();
  await app.getByRole('textbox', { name: 'Edge 语音', exact: true }).fill('zh-CN-YunxiNeural');
  await app.getByRole('spinbutton', { name: '最长录音时长' }).fill('30');
  await app.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
  await app.reload();
  await expect(app.getByRole('textbox', { name: 'Edge 语音', exact: true })).toHaveValue('zh-CN-YunxiNeural');
  await expect(app.getByRole('spinbutton', { name: '最长录音时长' })).toHaveValue('30');
  const config = await api(app, '/api/config');
  await testInfo.attach('voice-config', { body: JSON.stringify({ tts: config.tts, sttProvider: config.stt?.provider, voice: config.voice }, null, 2), contentType: 'application/json' });
  await app.getByRole('textbox', { name: 'Edge 语音', exact: true }).fill(originalVoice);
  await app.getByRole('spinbutton', { name: '最长录音时长' }).fill(originalDuration);
  await app.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
});

test('VOICE-003 真实 Edge 语音合成和播放', async ({ app }, testInfo) => {
  await route(app, '/voice');
  await app.getByRole('button', { name: /^Edge TTS 无需密钥/ }).click();
  await app.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
  await app.getByRole('textbox', { name: '朗读测试文本', exact: true }).fill('你好，这是桌面端语音播放测试。');
  await app.getByRole('button', { name: '测试朗读', exact: true }).click();
  await expect(app.getByText('朗读测试已开始播放。', { exact: true })).toBeVisible({ timeout: 60_000 });
  // Read the actual HTMLAudioElement created by the UI. Do not replace Audio,
  // the synthesis response, the device, or the application's speech API.
  const cdp = await app.context().newCDPSession(app);
  const prototype = await cdp.send('Runtime.evaluate', { expression: 'HTMLAudioElement.prototype' });
  const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId! });
  const audio = await cdp.send('Runtime.callFunctionOn', {
    objectId: objects.objects.objectId,
    functionDeclaration: 'function(){return this.map(a=>({readyState:a.readyState,duration:a.duration,currentTime:a.currentTime,paused:a.paused,sourceBytes:a.src.length,audioData:a.src.startsWith("data:audio/")}))}',
    returnByValue: true,
  });
  await cdp.detach();
  expect(audio.result.value.some((a: any) => a.audioData && a.sourceBytes > 1000 && a.duration > 0)).toBe(true);
  await testInfo.attach('actual-audio-playback', { body: JSON.stringify(audio.result.value, null, 2), contentType: 'application/json' });
});
