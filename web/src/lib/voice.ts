import { AudioSpeakResponse, AudioTranscriptionResponse, ElevenLabsVoicesResponse } from "@hermes/protocol";
import { fetchJSON, postJSON } from "@/lib/transport";

const DEFAULT_MAX_RECORDING_SECONDS = 120;
const MIN_RECORDING_SECONDS = 1;
const MAX_RECORDING_SECONDS = 600;

const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|[\u{FE0F}\u{200D}]|[\u{E0020}-\u{E007F}])+/gu;
const FENCED_CODE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`([^`]+)`/g;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\([^)]+\)/g;
const MARKDOWN_LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const PARAGRAPH_BREAK_RE = /[ \t]*\n{2,}[ \t]*/g;
const SOFT_BREAK_RE = /[ \t]*\n[ \t]*/g;
const THINKING_PREFIX_RE =
  /^\s*(?:\([^\)\n]{1,48}\)\s*)?(?:processing|thinking|reasoning|analyzing|pondering|contemplating|musing|cogitating|ruminating|deliberating|mulling|reflecting|computing|synthesizing|formulating|brainstorming)\.{2,}\s*/i;
const URL_RE = /\bhttps?:\/\/\S+/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nestedValue(config: Record<string, unknown> | undefined | null, path: string): unknown {
  if (!config) return undefined;
  return path.split(".").reduce<unknown>((current, key) => asRecord(current)?.[key], config);
}

function clampRecordingSeconds(value: number): number {
  return Math.max(
    MIN_RECORDING_SECONDS,
    Math.min(MAX_RECORDING_SECONDS, Math.trunc(value)),
  );
}

export function voiceMaxRecordingSecondsFromConfig(
  config: Record<string, unknown> | undefined | null,
): number {
  const value = nestedValue(config, "voice.max_recording_seconds");
  if (typeof value === "number" && Number.isFinite(value)) {
    return clampRecordingSeconds(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return clampRecordingSeconds(parsed);
  }
  return DEFAULT_MAX_RECORDING_SECONDS;
}

export function voiceAutoTtsFromConfig(
  config: Record<string, unknown> | undefined | null,
): boolean {
  return nestedValue(config, "voice.auto_tts") === true;
}

export function sttEnabledFromConfig(
  config: Record<string, unknown> | undefined | null,
): boolean {
  return nestedValue(config, "stt.enabled") !== false;
}

function normalizeLineBreaks(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(\p{L})-\n(\p{L})/gu, "$1$2")
    .replace(PARAGRAPH_BREAK_RE, "。 ")
    .replace(SOFT_BREAK_RE, " ");
}

export function sanitizeTextForSpeech(text: string): string {
  return normalizeLineBreaks(text)
    .replace(FENCED_CODE_RE, " ")
    .replace(THINKING_PREFIX_RE, " ")
    .replace(MARKDOWN_IMAGE_RE, "$1")
    .replace(MARKDOWN_LINK_RE, "$1")
    .replace(INLINE_CODE_RE, "$1")
    .replace(URL_RE, "链接")
    .replace(EMOJI_RE, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>#]/g, "")
    .replace(/^\s*[-+*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取录音数据"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("录音数据格式无效"));
      }
    };
    reader.readAsDataURL(blob);
  });
}

export async function transcribeAudioBlob(blob: Blob): Promise<AudioTranscriptionResponse> {
  const dataUrl = await blobToDataUrl(blob);
  return postJSON(
    "/api/audio/transcribe",
    {
      data_url: dataUrl,
      mime_type: blob.type || undefined,
    },
    AudioTranscriptionResponse,
  );
}

export function speakText(text: string): Promise<AudioSpeakResponse> {
  return postJSON(
    "/api/audio/speak",
    { text },
    AudioSpeakResponse,
  );
}

export function getElevenLabsVoices(): Promise<ElevenLabsVoicesResponse> {
  return fetchJSON("/api/audio/elevenlabs/voices", undefined, ElevenLabsVoicesResponse);
}

export function isVoiceSetupErrorMessage(message: string): boolean {
  const lower = message.toLowerCase();
  return [
    "no stt provider available",
    "no tts provider available",
    "groq_api_key",
    "voice_tools_openai_key",
    "openai_api_key",
    "elevenlabs_api_key",
    "xai_api_key",
    "no xai credentials",
    "edge-tts",
    "faster-whisper",
    "hermes_local_stt_command",
    "语音识别尚未配置",
    "回复朗读尚未配置",
    "需要配置",
  ].some((needle) => lower.includes(needle));
}

export function voiceErrorMessage(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error || "");
  const message = raw.trim();
  if (!message) return fallback;

  const lower = message.toLowerCase();
  if (lower.includes("no stt provider available")) {
    return "语音识别尚未配置可用提供方。请到“语音”设置选择本地识别，或填写 Groq、OpenAI、xAI、ElevenLabs 的 API Key。";
  }
  if (lower.includes("no tts provider available")) {
    return "回复朗读尚未配置可用的语音合成提供方。请到“语音”设置选择 Edge TTS（需 edge-tts 依赖）、OpenAI、ElevenLabs 或本地 TTS。";
  }
  if (lower.includes("groq_api_key")) {
    return "Groq 语音识别需要配置 GROQ_API_KEY，请到“语音”设置填写 API Key。";
  }
  if (lower.includes("voice_tools_openai_key") || lower.includes("openai_api_key")) {
    return "OpenAI 语音功能需要配置 VOICE_TOOLS_OPENAI_KEY，请到“语音”设置填写 API Key。";
  }
  if (lower.includes("elevenlabs_api_key")) {
    return "ElevenLabs 语音功能需要配置 ELEVENLABS_API_KEY，请到“语音”设置填写 API Key。";
  }
  if (lower.includes("xai_api_key") || lower.includes("no xai credentials")) {
    return "xAI 语音识别需要配置 XAI_API_KEY 或完成 xAI OAuth，请到“语音”设置填写 API Key。";
  }
  if (lower.includes("edge-tts")) {
    return "Edge TTS 依赖不可用；macOS 不自带 edge-tts，请安装该依赖，或到“语音”设置切换其它朗读提供方。";
  }
  if (lower.includes("faster-whisper") || lower.includes("hermes_local_stt_command")) {
    return "本地语音识别依赖不可用，请安装 faster-whisper、本地 whisper CLI，或到“语音”设置切换云端识别提供方。";
  }
  if (lower.includes("http 404") || lower.includes("not found")) {
    return "当前 Hermes runtime 不支持语音接口，请先更新 runtime。";
  }
  if (lower.includes("audio recording is empty")) {
    return "录音为空，请重新录制。";
  }
  if (lower.includes("audio recording is too large") || lower.includes("http 413")) {
    return "录音过长或文件过大，请缩短录音后重试。";
  }
  if (lower.includes("payload must be an audio recording")) {
    return "录音格式不受当前 runtime 支持，请换用系统默认麦克风后重试。";
  }
  if (lower.includes("text is required")) {
    return "没有可朗读的文本。";
  }
  if (message.includes("麦克风") || message.includes("权限") || message.includes("录音")) {
    return message;
  }
  return `${fallback}：${message}`;
}
