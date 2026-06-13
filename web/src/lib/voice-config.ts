import type { ConfigSchemaResponse, EnvVarInfo } from "@hermes/protocol";
import { buildNestedConfigUpdate, mergeConfigUpdate } from "@/lib/config-update";

export type VoiceConfigKind = "stt" | "tts";

export interface VoiceProviderMeta {
  id: string;
  label: string;
  description: string;
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

const STT_PROVIDER_ALLOWLIST = new Set(["local", "groq", "openai", "xai", "elevenlabs"]);

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
    configKeys: [],
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
    description: "Microsoft Edge 神经网络语音，免费，不需要 API Key。",
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
};

export const VOICE_FIELD_LABELS: Record<string, string> = {
  "stt.local.model": "本地识别模型",
  "stt.local.language": "识别语言",
  "stt.openai.model": "OpenAI 识别模型",
  "stt.elevenlabs.model_id": "ElevenLabs STT 模型",
  "stt.elevenlabs.language_code": "ElevenLabs 语言代码",
  "stt.elevenlabs.tag_audio_events": "标记音频事件",
  "stt.elevenlabs.diarize": "说话人区分",
  "tts.edge.voice": "Edge 语音",
  "tts.openai.model": "OpenAI TTS 模型",
  "tts.openai.voice": "OpenAI 语音",
  "tts.elevenlabs.voice_id": "ElevenLabs 语音",
  "tts.elevenlabs.model_id": "ElevenLabs 模型",
  "tts.neutts.model": "NeuTTS 模型",
  "tts.neutts.device": "NeuTTS 设备",
  "tts.neutts.ref_audio": "NeuTTS 参考音频",
  "tts.neutts.ref_text": "NeuTTS 参考文本",
};

export const VOICE_FIELD_PLACEHOLDERS: Record<string, string> = {
  "stt.local.model": "base",
  "stt.local.language": "zh",
  "stt.openai.model": "whisper-1",
  "stt.elevenlabs.model_id": "scribe_v2",
  "stt.elevenlabs.language_code": "zho",
  "tts.edge.voice": "zh-CN-XiaoxiaoNeural",
  "tts.openai.model": "gpt-4o-mini-tts",
  "tts.openai.voice": "alloy",
  "tts.elevenlabs.model_id": "eleven_multilingual_v2",
  "tts.neutts.device": "cpu",
};

export const VOICE_SELECT_OPTIONS: Record<string, string[]> = {
  "stt.local.model": ["tiny", "base", "small", "medium", "large-v3"],
  "stt.openai.model": ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"],
  "stt.elevenlabs.model_id": ["scribe_v2", "scribe_v1"],
  "tts.openai.voice": ["alloy", "echo", "fable", "onyx", "nova", "shimmer"],
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
  const schemaOptions = schema?.fields[schemaKey]?.options ?? [];
  const supported = kind === "stt"
    ? schemaOptions.filter((id) => STT_PROVIDER_ALLOWLIST.has(id))
    : schemaOptions;

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

