import type { ConfigSchemaResponse, EnvVarInfo } from "@hermes/protocol";
import { buildNestedConfigUpdate, mergeConfigUpdate } from "@/lib/config-update";

export type VoiceConfigKind = "stt" | "tts";

export interface VoiceProviderMeta {
  id: string;
  label: string;
  description: string;
  notice?: string;
  envKey?: string;
  configKeys: readonly string[];
  local?: boolean;
  unsupported?: boolean;
}

export interface VoiceSettingsDraft {
  sttEnabled: boolean;
  sttProvider: string;
  ttsProvider: string;
  autoTts: boolean;
  maxRecordingSeconds: number;
  values: Record<string, string | boolean | number>;
  sttApiKey: string;
  ttsApiKey: string;
}

export interface VoiceEnvUpdate {
  key: string;
  value: string;
}

const STT_PROVIDER_META: Record<string, VoiceProviderMeta> = {
  local: {
    id: "local",
    label: "本地识别",
    description: "优先使用 faster-whisper 或本地 whisper CLI，不需要云端 API Key。",
    local: true,
    configKeys: ["stt.local.model", "stt.local.language"],
  },
  groq: {
    id: "groq",
    label: "Groq Whisper",
    description: "云端 Whisper，速度快，有免费额度，需要 GROQ_API_KEY。",
    envKey: "GROQ_API_KEY",
    configKeys: ["stt.groq.model"],
  },
  openai: {
    id: "openai",
    label: "OpenAI Whisper",
    description: "OpenAI 语音转文字，优先读取 VOICE_TOOLS_OPENAI_KEY。",
    envKey: "VOICE_TOOLS_OPENAI_KEY",
    configKeys: ["stt.openai.model"],
  },
  xai: {
    id: "xai",
    label: "xAI Grok STT",
    description: "xAI Grok 语音识别，需要 XAI_API_KEY 或已配置 xAI OAuth。",
    envKey: "XAI_API_KEY",
    configKeys: [],
  },
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs Scribe",
    description: "ElevenLabs Scribe 语音识别，需要 ELEVENLABS_API_KEY。",
    envKey: "ELEVENLABS_API_KEY",
    configKeys: [
      "stt.elevenlabs.model_id",
      "stt.elevenlabs.language_code",
      "stt.elevenlabs.tag_audio_events",
      "stt.elevenlabs.diarize",
    ],
  },
};

const TTS_PROVIDER_META: Record<string, VoiceProviderMeta> = {
  edge: {
    id: "edge",
    label: "Edge TTS",
    description: "Microsoft Edge 神经网络语音，免费，不需要 API Key，但需要 edge-tts 依赖。",
    notice: "备注：Edge TTS 不是 macOS 系统或 Microsoft Edge 浏览器自带能力；当前运行环境需要能调用 edge-tts 依赖。若测试朗读提示 edge-tts 不可用，请安装依赖或切换 OpenAI、ElevenLabs、NeuTTS。",
    local: true,
    configKeys: ["tts.edge.voice"],
  },
  openai: {
    id: "openai",
    label: "OpenAI TTS",
    description: "OpenAI 语音合成，优先读取 VOICE_TOOLS_OPENAI_KEY。",
    envKey: "VOICE_TOOLS_OPENAI_KEY",
    configKeys: ["tts.openai.model", "tts.openai.voice"],
  },
  elevenlabs: {
    id: "elevenlabs",
    label: "ElevenLabs TTS",
    description: "ElevenLabs 高质量语音合成，需要 ELEVENLABS_API_KEY。",
    envKey: "ELEVENLABS_API_KEY",
    configKeys: ["tts.elevenlabs.voice_id", "tts.elevenlabs.model_id"],
  },
  neutts: {
    id: "neutts",
    label: "NeuTTS",
    description: "本地语音合成，需要本机已安装 NeuTTS 依赖。",
    local: true,
    configKeys: ["tts.neutts.model", "tts.neutts.device", "tts.neutts.ref_audio", "tts.neutts.ref_text"],
  },
  xai: {
    id: "xai",
    label: "xAI Grok TTS",
    description: "xAI Grok 语音合成，使用 xAI OAuth 或 XAI_API_KEY。",
    envKey: "XAI_API_KEY",
    configKeys: ["tts.xai.voice_id", "tts.xai.language", "tts.xai.speed", "tts.xai.auto_speech_tags"],
  },
  minimax: {
    id: "minimax",
    label: "MiniMax TTS",
    description: "MiniMax 语音合成，需要 MINIMAX_API_KEY。",
    envKey: "MINIMAX_API_KEY",
    configKeys: ["tts.minimax.model", "tts.minimax.voice_id"],
  },
  mistral: {
    id: "mistral",
    label: "Mistral TTS",
    description: "Mistral Voxtral 语音合成，需要 MISTRAL_API_KEY。",
    envKey: "MISTRAL_API_KEY",
    configKeys: ["tts.mistral.model", "tts.mistral.voice_id"],
  },
  gemini: {
    id: "gemini",
    label: "Gemini TTS",
    description: "Google Gemini 语音合成，需要 GEMINI_API_KEY。",
    envKey: "GEMINI_API_KEY",
    configKeys: ["tts.gemini.model", "tts.gemini.voice"],
  },
  kittentts: {
    id: "kittentts",
    label: "KittenTTS",
    description: "本地语音合成，需要本机已安装 KittenTTS 依赖。",
    local: true,
    configKeys: ["tts.kittentts.model", "tts.kittentts.voice"],
  },
  piper: {
    id: "piper",
    label: "Piper",
    description: "本地轻量语音合成，需要本机已安装 piper 依赖。",
    local: true,
    configKeys: ["tts.piper.voice"],
  },
};

export const VOICE_FIELD_LABELS: Record<string, string> = {
  "voice.record_key": "录音快捷键",
  "voice.submit_mode": "提交模式",
  "voice.max_recording_seconds": "最大录音时长（秒）",
  "voice.auto_tts": "自动朗读回复",
  "voice.beep_enabled": "启用提示音",
  "voice.beep_volume": "提示音音量",
  "voice.thinking_sound": "思考提示音",
  "voice.silence_threshold": "静音阈值（RMS）",
  "voice.silence_duration": "静音停止时长（秒）",
  "voice.barge_in": "启用打断",
  "voice.barge_in_grace_seconds": "打断 grace 时长（秒）",
  "voice.barge_in_threshold_multiplier": "打断阈值倍数",
  "voice.stop_phrases": "停止短语",
  "stt.local.model": "本地识别模型",
  "stt.local.language": "识别语言",
  "stt.openai.model": "OpenAI 识别模型",
  "stt.groq.model": "Groq 识别模型",
  "stt.elevenlabs.model_id": "ElevenLabs STT 模型",
  "stt.elevenlabs.language_code": "ElevenLabs 语言代码",
  "stt.elevenlabs.tag_audio_events": "标记音频事件",
  "stt.elevenlabs.diarize": "说话人区分",
  "tts.edge.voice": "Edge 语音",
  "tts.openai.model": "OpenAI TTS 模型",
  "tts.openai.voice": "OpenAI 语音",
  "tts.elevenlabs.voice_id": "ElevenLabs 语音",
  "tts.elevenlabs.model_id": "ElevenLabs 模型",
  "tts.xai.voice_id": "xAI 语音",
  "tts.xai.language": "xAI 语言",
  "tts.xai.speed": "xAI 语速",
  "tts.xai.auto_speech_tags": "xAI 自动语音标签",
  "tts.minimax.model": "MiniMax 模型",
  "tts.minimax.voice_id": "MiniMax 语音",
  "tts.mistral.model": "Mistral 模型",
  "tts.mistral.voice_id": "Mistral 语音",
  "tts.gemini.model": "Gemini 模型",
  "tts.gemini.voice": "Gemini 语音",
  "tts.kittentts.model": "KittenTTS 模型",
  "tts.kittentts.voice": "KittenTTS 语音",
  "tts.piper.voice": "Piper 语音",
  "tts.neutts.model": "NeuTTS 模型",
  "tts.neutts.device": "NeuTTS 设备",
  "tts.neutts.ref_audio": "NeuTTS 参考音频",
  "tts.neutts.ref_text": "NeuTTS 参考文本",
};

export const VOICE_FIELD_PLACEHOLDERS: Record<string, string> = {
  "stt.local.model": "base",
  "stt.local.language": "zh",
  "stt.groq.model": "whisper-large-v3-turbo",
  "stt.openai.model": "whisper-1",
  "stt.elevenlabs.model_id": "scribe_v2",
  "stt.elevenlabs.language_code": "zho",
  "tts.edge.voice": "zh-CN-XiaoxiaoNeural",
  "tts.openai.model": "gpt-4o-mini-tts",
  "tts.openai.voice": "alloy",
  "tts.elevenlabs.model_id": "eleven_multilingual_v2",
  "tts.xai.voice_id": "eve",
  "tts.xai.language": "en",
  "tts.xai.speed": "1.0",
  "tts.minimax.model": "speech-02-hd",
  "tts.minimax.voice_id": "English_expressive_narrator",
  "tts.mistral.model": "voxtral-mini-tts-2603",
  "tts.mistral.voice_id": "c69964a6-ab8b-4f8a-9465-ec0925096ec8",
  "tts.gemini.model": "gemini-2.5-flash-preview-tts",
  "tts.gemini.voice": "Kore",
  "tts.kittentts.model": "KittenML/kitten-tts-nano-0.8-int8",
  "tts.kittentts.voice": "Jasper",
  "tts.piper.voice": "en_US-lessac-medium",
  "tts.neutts.device": "cpu",
};

export const VOICE_SELECT_OPTIONS: Record<string, string[]> = {
  "stt.local.model": ["tiny", "base", "small", "medium", "large-v3"],
  "stt.openai.model": ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe", "gpt-transcribe"],
  "stt.elevenlabs.model_id": ["scribe_v2", "scribe_v1"],
  "tts.openai.model": ["gpt-4o-mini-tts", "gpt-4o-tts", "tts-1", "tts-1-hd"],
  "tts.openai.voice": [
    "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
    "marin", "nova", "onyx", "sage", "shimmer", "verse",
  ],
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function getVoiceConfigValue(config: Record<string, unknown> | null | undefined, path: string): unknown {
  if (!config) return undefined;
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)?.[key], config);
}

function currentProvider(config: Record<string, unknown> | null | undefined, kind: VoiceConfigKind): string {
  const key = kind === "stt" ? "stt.provider" : "tts.provider";
  const fallback = kind === "stt" ? "local" : "edge";
  const value = getVoiceConfigValue(config, key);
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function providerMeta(kind: VoiceConfigKind, id: string): VoiceProviderMeta {
  const catalog = kind === "stt" ? STT_PROVIDER_META : TTS_PROVIDER_META;
  return catalog[id] ?? {
    id,
    label: id,
    description: "当前 runtime schema 声明了此语音提供方，但桌面端还没有专门说明。",
    configKeys: [],
  };
}

export function voiceProviderEnvKey(kind: VoiceConfigKind, provider: string): string | undefined {
  return providerMeta(kind, provider).envKey;
}

export function voiceProviderOptions(
  kind: VoiceConfigKind,
  schema: ConfigSchemaResponse | null | undefined,
  current: string,
): VoiceProviderMeta[] {
  const schemaKey = kind === "stt" ? "stt.provider" : "tts.provider";
  // Schema is the source of truth for provider options (backend merges
  // command/plugin providers per-request). No desktop-side allowlist —
  // mirror TTS behaviour so custom command STT providers are visible.
  const supported = schema?.fields[schemaKey]?.options ?? [];

  const options = supported.map((id) => providerMeta(kind, id));
  if (current && !supported.includes(current)) {
    options.push({
      ...providerMeta(kind, current),
      label: `${providerMeta(kind, current).label}（当前配置）`,
      description: "当前配置使用了这个提供方，但当前 runtime schema 未声明它；保存前建议切换到可用选项。",
      unsupported: true,
    });
  }
  return options;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function voiceSettingsDraftFromConfig(
  config: Record<string, unknown> | null | undefined,
): VoiceSettingsDraft {
  const sttProvider = currentProvider(config, "stt");
  const ttsProvider = currentProvider(config, "tts");
  const values: Record<string, string | boolean | number> = {};
  for (const meta of [providerMeta("stt", sttProvider), providerMeta("tts", ttsProvider)]) {
    for (const key of meta.configKeys) {
      const value = getVoiceConfigValue(config, key);
      if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
        values[key] = value;
      } else {
        values[key] = "";
      }
    }
  }

  return {
    sttEnabled: normalizeBoolean(getVoiceConfigValue(config, "stt.enabled"), true),
    sttProvider,
    ttsProvider,
    autoTts: normalizeBoolean(getVoiceConfigValue(config, "voice.auto_tts"), false),
    maxRecordingSeconds: normalizeNumber(getVoiceConfigValue(config, "voice.max_recording_seconds"), 120),
    values,
    sttApiKey: "",
    ttsApiKey: "",
  };
}

function shouldPersistValue(value: string | boolean | number | undefined): value is string | boolean | number {
  if (typeof value === "boolean" || typeof value === "number") return true;
  return typeof value === "string" && value.trim().length > 0;
}

export function buildVoiceSaveConfig(
  current: Record<string, unknown>,
  draft: VoiceSettingsDraft,
): Record<string, unknown> {
  const sttMeta = providerMeta("stt", draft.sttProvider);
  const ttsMeta = providerMeta("tts", draft.ttsProvider);
  const patches: Record<string, unknown>[] = [
    buildNestedConfigUpdate("stt.enabled", draft.sttEnabled),
    buildNestedConfigUpdate("stt.provider", draft.sttProvider),
    buildNestedConfigUpdate("tts.provider", draft.ttsProvider),
    buildNestedConfigUpdate("voice.auto_tts", draft.autoTts),
    buildNestedConfigUpdate("voice.max_recording_seconds", Math.max(1, Math.trunc(draft.maxRecordingSeconds || 120))),
  ];

  for (const key of [...sttMeta.configKeys, ...ttsMeta.configKeys]) {
    const value = draft.values[key];
    if (shouldPersistValue(value)) patches.push(buildNestedConfigUpdate(key, value));
  }

  return patches.reduce((next, patch) => mergeConfigUpdate(next, patch), current);
}

export function buildVoiceEnvUpdates(draft: VoiceSettingsDraft): VoiceEnvUpdate[] {
  const updates = new Map<string, string>();
  const sttEnv = voiceProviderEnvKey("stt", draft.sttProvider);
  const ttsEnv = voiceProviderEnvKey("tts", draft.ttsProvider);
  const sttKey = draft.sttApiKey.trim();
  const ttsKey = draft.ttsApiKey.trim();
  if (sttEnv && sttKey) updates.set(sttEnv, sttKey);
  if (ttsEnv && ttsKey) updates.set(ttsEnv, ttsKey);
  return Array.from(updates, ([key, value]) => ({ key, value }));
}

export function envConfigured(envVars: Record<string, EnvVarInfo> | undefined, key: string | undefined): boolean {
  if (!key) return true;
  return Boolean(envVars?.[key]?.is_set);
}
