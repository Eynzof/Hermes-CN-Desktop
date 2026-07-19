import { describe, expect, it } from "vitest";
import type { ConfigSchemaResponse, EnvVarInfo } from "@hermes/protocol";

import {
  buildVoiceEnvUpdates,
  buildVoiceSaveConfig,
  envConfigured,
  voiceProviderEnvKey,
  voiceProviderOptions,
  voiceSettingsDraftFromConfig,
  type VoiceSettingsDraft,
} from "./voice-config";

const schema: ConfigSchemaResponse = {
  category_order: ["stt", "tts", "voice"],
  fields: {
    "stt.provider": {
      type: "select",
      description: "Speech-to-text provider",
      category: "stt",
      options: ["local", "groq", "openai", "mistral", "xai", "elevenlabs"],
    },
    "tts.provider": {
      type: "select",
      description: "Text-to-speech provider",
      category: "tts",
      options: ["edge", "openai", "elevenlabs", "neutts"],
    },
  },
};

function draft(overrides: Partial<VoiceSettingsDraft> = {}): VoiceSettingsDraft {
  return {
    sttEnabled: true,
    sttProvider: "openai",
    ttsProvider: "elevenlabs",
    autoTts: false,
    maxRecordingSeconds: 120,
    values: {
      "stt.openai.model": "gpt-4o-mini-transcribe",
      "tts.elevenlabs.model_id": "eleven_multilingual_v2",
      "tts.elevenlabs.voice_id": "voice-1",
    },
    sttApiKey: "",
    ttsApiKey: "",
    ...overrides,
  };
}

describe("voice provider helpers", () => {
  it("maps provider API keys", () => {
    expect(voiceProviderEnvKey("stt", "groq")).toBe("GROQ_API_KEY");
    expect(voiceProviderEnvKey("stt", "openai")).toBe("VOICE_TOOLS_OPENAI_KEY");
    expect(voiceProviderEnvKey("tts", "elevenlabs")).toBe("ELEVENLABS_API_KEY");
    expect(voiceProviderEnvKey("tts", "edge")).toBeUndefined();
  });

  it("filters STT providers through the desktop-supported allowlist", () => {
    const providers = voiceProviderOptions("stt", schema, "local").map((item) => item.id);

    expect(providers).toEqual(["local", "groq", "openai", "xai", "elevenlabs"]);
    expect(providers).not.toContain("mistral");
  });

  it("keeps unsupported current providers visible as compatibility entries", () => {
    const providers = voiceProviderOptions("stt", schema, "mistral");
    const current = providers.find((item) => item.id === "mistral");

    expect(current?.unsupported).toBe(true);
    expect(current?.label).toContain("当前配置");
  });
});

describe("voice save helpers", () => {
  it("builds nested config updates for selected STT and TTS providers", () => {
    const next = buildVoiceSaveConfig(
      { stt: { provider: "local" }, tts: { provider: "edge" }, voice: {} },
      draft({ autoTts: true, maxRecordingSeconds: 42 }),
    );

    expect(next).toMatchObject({
      stt: {
        enabled: true,
        provider: "openai",
        openai: { model: "gpt-4o-mini-transcribe" },
      },
      tts: {
        provider: "elevenlabs",
        elevenlabs: {
          model_id: "eleven_multilingual_v2",
          voice_id: "voice-1",
        },
      },
      voice: { auto_tts: true, max_recording_seconds: 42 },
    });
  });

  it("does not write empty API key inputs", () => {
    expect(buildVoiceEnvUpdates(draft())).toEqual([]);
  });

  it("deduplicates shared OpenAI voice API key updates", () => {
    const updates = buildVoiceEnvUpdates(draft({
      ttsProvider: "openai",
      sttApiKey: "sk-stt",
      ttsApiKey: "sk-tts",
    }));

    expect(updates).toEqual([{ key: "VOICE_TOOLS_OPENAI_KEY", value: "sk-tts" }]);
  });

  it("reads draft state from nested config", () => {
    const value = voiceSettingsDraftFromConfig({
      stt: { enabled: false, provider: "groq" },
      tts: { provider: "edge", edge: { voice: "zh-CN-XiaoxiaoNeural" } },
      voice: { auto_tts: true, max_recording_seconds: "30" },
    });

    expect(value).toMatchObject({
      sttEnabled: false,
      sttProvider: "groq",
      ttsProvider: "edge",
      autoTts: true,
      maxRecordingSeconds: 30,
    });
    expect(value.values["tts.edge.voice"]).toBe("zh-CN-XiaoxiaoNeural");
  });

  it("reports existing env keys as configured", () => {
    const envVars: Record<string, EnvVarInfo> = {
      ELEVENLABS_API_KEY: {
        is_set: true,
        redacted_value: "••••",
        description: "",
        url: null,
        category: "provider",
        is_password: true,
        tools: [],
        advanced: false,
      },
    };

    expect(envConfigured(envVars, "ELEVENLABS_API_KEY")).toBe(true);
    expect(envConfigured(envVars, "GROQ_API_KEY")).toBe(false);
    expect(envConfigured(envVars, undefined)).toBe(true);
  });
});

