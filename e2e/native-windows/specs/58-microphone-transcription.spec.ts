import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test, expect, route, api, sendChat, native, root, python } from '../fixtures';

test('VOICE-002 Windows 虚拟麦克风真实录音、离开取消、转写与 DeepSeek 文字发送', async ({ app }, testInfo) => {
  test.setTimeout(240_000);
  const script = path.join(root, 'native-windows', 'scripts', 'virtual-microphone.py');
  const calibration = path.join(testInfo.outputDir, 'virtual-mic-calibration');
  execFileSync(python, [script, '--root', root, '--prepare', '--verify', '--output', calibration], { windowsHide: true, timeout: 30_000 });
  const metadata = JSON.parse(readFileSync(calibration + '.json', 'utf8'));
  expect(metadata.inputPeak).toBeGreaterThan(0.005);
  await testInfo.attach('actual-microphone-input', { path: calibration + '.wav', contentType: 'audio/wav' });
  await testInfo.attach('virtual-microphone-provenance', { path: calibration + '.json', contentType: 'application/json' });
  await route(app, '/voice');
  const original = await api(app, '/api/config');
  const originalDuration = await app.getByRole('spinbutton', { name: '最长录音时长', exact: true }).inputValue();
  const language = app.getByRole('textbox', { name: '识别语言', exact: true });
  const originalLanguage = await language.inputValue();
  expect(original.stt.provider).toBe('local');
  await app.getByRole('spinbutton', { name: '最长录音时长', exact: true }).fill('15');
  await language.fill('zh');
  await app.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
  const cdp = await app.context().newCDPSession(app);
  const startRecording = async () => {
    const permission = await app.evaluate(async () => (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state);
    expect(permission, 'The actual WebView microphone permission must not be denied').not.toBe('denied');
    await app.getByRole('button', { name: /^语音输入/ }).click();
    if (permission === 'prompt') {
      const pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', '(Get-NetTCPConnection -LocalPort 19229 -State Listen).OwningProcess'], { encoding: 'utf8', windowsHide: true }).trim());
      let prompt: any;
      await expect.poll(async () => {
        for (const window of (await native({ action: 'systemWindows' })).windows.filter((w: any) => w.pid === pid && w.type === 'Chrome_WidgetWin_1')) {
          const snapshot = await native({ action: 'externalSnapshot', windowClass: window.type, windowHandle: window.handle, window: window.text });
          if (snapshot.controls.some((c: any) => c.name === 'http://hermesui.localhost 想要') && snapshot.controls.some((c: any) => c.name === '使用麦克风')) { prompt = { window, snapshot }; return true; }
        }
        return false;
      }, { timeout: 30_000 }).toBe(true);
      expect(prompt.snapshot.controls.some((c: any) => c.name === '允许' && c.id === 'allow-button')).toBe(true);
      await testInfo.attach('native-microphone-permission', { body: JSON.stringify(prompt.snapshot, null, 2), contentType: 'application/json' });
      const shot = await native({ action: 'screenshot' });
      await testInfo.attach('native-permission-screen', { path: shot.path, contentType: 'image/png' });
      await native({ action: 'externalInvoke', windowClass: prompt.window.type, windowHandle: prompt.window.handle, window: prompt.window.text, controlName: '允许' });
    }
    await expect(app.getByText('正在录音', { exact: true })).toBeVisible();
  };
  const recorderState = async () => {
    const prototype = await cdp.send('Runtime.evaluate', { expression: 'MediaRecorder.prototype' });
    const objects = await cdp.send('Runtime.queryObjects', { prototypeObjectId: prototype.result.objectId! });
    const states = await cdp.send('Runtime.callFunctionOn', { objectId: objects.objects.objectId,
      functionDeclaration: 'function(){return this.map(r=>({state:r.state,mimeType:r.mimeType,tracks:r.stream.getAudioTracks().map(t=>({id:t.id,label:t.label,readyState:t.readyState,settings:t.getSettings()}))}))}', returnByValue: true });
    await cdp.send('Runtime.releaseObject', { objectId: objects.objects.objectId });
    await cdp.send('Runtime.releaseObject', { objectId: prototype.result.objectId! });
    return states.result.value;
  };
  try {
    await route(app, '/');
    await startRecording();
    const active = (await recorderState()).filter((item: any) => item.state === 'recording');
    expect(active).toHaveLength(1);
    expect(active[0].tracks[0].label).toContain('CABLE Output');
    await testInfo.attach('actual-recording-device', { body: JSON.stringify(active, null, 2), contentType: 'application/json' });
    const trackId = active[0].tracks[0].id;
    await route(app, '/health');
    await expect.poll(async () => (await recorderState()).flatMap((item: any) => item.tracks).filter((track: any) => track.id === trackId && track.readyState === 'live')).toHaveLength(0);
    await route(app, '/');
    await expect(app.getByRole('textbox', { name: '输入消息', exact: true })).toHaveValue('');
    await startRecording();
    const player = spawn(python, [script, '--root', root, '--output', path.join(testInfo.outputDir, 'actual-utterance')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let playerLog = '';
    player.stdout.on('data', data => playerLog += data);
    player.stderr.on('data', data => playerLog += data);
    const played = new Promise<number | null>((resolve, reject) => { player.once('exit', resolve); player.once('error', reject); });
    expect(await played, playerLog).toBe(0);
    await testInfo.attach('utterance-delivery', { body: playerLog, contentType: 'application/json' });
    await app.getByRole('button', { name: '停止录音并转写', exact: true }).click();
    const composer = app.getByRole('textbox', { name: '输入消息', exact: true });
    await expect.poll(async () => (await composer.inputValue()).length > 0 || (await app.locator('[class*="errorText"]').allTextContents()).some(text => text.trim()), { timeout: 90_000 }).toBe(true);
    const errors = (await app.locator('[class*="errorText"]').allTextContents()).filter(text => text.trim());
    await testInfo.attach('actual-transcription-result', { body: JSON.stringify({ transcript: await composer.inputValue(), errors }, null, 2), contentType: 'application/json' });
    expect(errors, 'The real audio recording must be transcribed by the configured STT provider').toEqual([]);
    const transcript = await composer.inputValue();
    expect(transcript).toMatch(/[语語]音[输輸]入[测測][试試]/);
    expect(transcript).toMatch(/[语語]音[测測][试試]通[过過]/);
    await sendChat(app, transcript, /[语語]音[测測][试試]通[过過]/);
  } catch (error) {
    await testInfo.attach('voice-before-cleanup', { body: await app.screenshot(), contentType: 'image/png' });
    await testInfo.attach('voice-primary-error', { body: JSON.stringify({ error: String(error), messages: await app.locator('[class*="errorText"]').allTextContents() }), contentType: 'application/json' });
    throw error;
  } finally {
    // Leaving the composer stops its actual microphone tracks, including when
    // the configured STT provider fails. Never inject a canned transcript.
    await route(app, '/voice');
    await app.getByRole('spinbutton', { name: '最长录音时长', exact: true }).fill(originalDuration);
    await language.fill(originalLanguage);
    await app.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(app.getByText(/^语音配置已保存。/)).toBeVisible();
    await cdp.detach();
  }
});
