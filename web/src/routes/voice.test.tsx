import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConfigSchemaResponse, EnvVarInfo } from "@hermes/protocol";

import { voiceProviderOptions, voiceSettingsDraftFromConfig } from "@/lib/voice-config";
import { VoiceSettingsView } from "./voice";

const schema: ConfigSchemaResponse = {
  category_order: ["stt", "tts", "voice"],
  fields: {
    "stt.provider": {
      type: "select",
      description: "Speech-to-text provider",
      category: "stt",
      options: ["local", "groq", "openai", "xai", "elevenlabs"],
    },
    "tts.provider": {
      type: "select",
      description: "Text-to-speech provider",
      category: "tts",
      options: ["edge", "openai", "elevenlabs", "neutts"],
    },
    "stt.openai.model": {
      type: "string",
      description: "OpenAI STT model",
      category: "stt",
    },
    "tts.elevenlabs.voice_id": {
      type: "string",
      description: "ElevenLabs voice",
      category: "tts",
    },
    "tts.elevenlabs.model_id": {
      type: "string",
      description: "ElevenLabs model",
      category: "tts",
    },
  },
};

const envVars: Record<string, EnvVarInfo> = {
  VOICE_TOOLS_OPENAI_KEY: {
    is_set: true,
    redacted_value: "sk-***",
    description: "",
    url: null,
    category: "provider",
    is_password: true,
    tools: [],
    advanced: false,
  },
};

describe("VoiceSettingsView", () => {
  it("renders STT, TTS and experience setup cards", () => {
    const draft = voiceSettingsDraftFromConfig({
      stt: { enabled: true, provider: "openai", openai: { model: "whisper-1" } },
      tts: { provider: "elevenlabs", elevenlabs: { voice_id: "voice-1" } },
      voice: { auto_tts: false, max_recording_seconds: 120 },
    });
    const html = ReactDOMServer.renderToStaticMarkup(
      <VoiceSettingsView
        draft={draft}
        schema={schema}
        envVars={envVars}
        sttProviders={voiceProviderOptions("stt", schema, draft.sttProvider)}
        ttsProviders={voiceProviderOptions("tts", schema, draft.ttsProvider)}
        elevenLabsVoices={{
          available: true,
          voices: [{ voice_id: "voice-1", name: "Rachel", label: "Rachel (premade)" }],
        }}
      />,
    );

    expect(html).toContain("语音识别 STT");
    expect(html).toContain("回复朗读 TTS");
    expect(html).toContain("体验设置");
    expect(html).toContain("VOICE_TOOLS_OPENAI_KEY 已配置");
    expect(html).toContain("需要 ELEVENLABS_API_KEY");
    expect(html).toContain("Rachel (premade)");
    expect(html).toContain("保存配置");
  });
});

