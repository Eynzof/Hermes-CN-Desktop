import { describe, expect, it } from "vitest";

import {
  sanitizeTextForSpeech,
  isVoiceSetupErrorMessage,
  sttEnabledFromConfig,
  voiceAutoTtsFromConfig,
  voiceErrorMessage,
  voiceMaxRecordingSecondsFromConfig,
} from "./voice";

describe("voice config helpers", () => {
  it("reads voice settings from nested config", () => {
    const config = {
      stt: { enabled: true },
      voice: { auto_tts: true, max_recording_seconds: 42 },
    };

    expect(sttEnabledFromConfig(config)).toBe(true);
    expect(voiceAutoTtsFromConfig(config)).toBe(true);
    expect(voiceMaxRecordingSecondsFromConfig(config)).toBe(42);
  });

  it("defaults STT to enabled and clamps recording length", () => {
    expect(sttEnabledFromConfig({})).toBe(true);
    expect(voiceMaxRecordingSecondsFromConfig({ voice: { max_recording_seconds: 9999 } })).toBe(600);
    expect(voiceMaxRecordingSecondsFromConfig({ voice: { max_recording_seconds: "0" } })).toBe(1);
  });
});

describe("sanitizeTextForSpeech", () => {
  it("removes code, markdown wrappers, links and emoji before TTS", () => {
    const text = sanitizeTextForSpeech([
      "# 标题",
      "请看 [文档](https://example.test/docs) 😄",
      "```ts",
      "const secret = 'do-not-read';",
      "```",
      "行内 `code` 保留为普通词。",
      "图片 ![截图](https://example.test/a.png)",
    ].join("\n"));

    expect(text).toContain("标题");
    expect(text).toContain("文档");
    expect(text).toContain("code");
    expect(text).toContain("截图");
    expect(text).not.toContain("https://example.test");
    expect(text).not.toContain("do-not-read");
    expect(text).not.toContain("😄");
  });
});

describe("voiceErrorMessage", () => {
  it("maps old runtime 404 to an update hint", () => {
    expect(voiceErrorMessage(new Error("HTTP 404: Not Found"), "语音失败"))
      .toBe("当前 Hermes runtime 不支持语音接口，请先更新 runtime。");
  });

  it("maps missing STT provider errors to a setup hint", () => {
    const message = voiceErrorMessage(
      new Error("HTTP 400: {\"detail\":\"No STT provider available. Install faster-whisper or set GROQ_API_KEY\"}"),
      "语音转写失败",
    );

    expect(message).toContain("语音识别尚未配置可用提供方");
    expect(isVoiceSetupErrorMessage(message)).toBe(true);
  });
});
