/**
 * TTS provider breadth (11 providers).
 *
 * Production desktop routes through the managed Python runtime
 * (`/api/audio/speak`); direct API providers below work when their env key is
 * configured (browser-only dev). Providers without a key surface an actionable
 * error instead of faking audio.
 */

import type { TTSProvider } from "../types";

function envKey(name: string): string | undefined {
  return (
    import.meta.env?.[name] ??
    (typeof window !== "undefined" ? (window as unknown as Record<string, string | undefined>)[name] : undefined)
  );
}

function managedRuntimeProvider(id: string, name: string): TTSProvider {
  return {
    id,
    available: () => false, // real availability lives in the managed runtime
    async synthesize() {
      throw new Error(
        `${name} TTS is served by the managed Python runtime (/api/audio/speak) — no direct key configured`,
      );
    },
  };
}

async function fetchAudio(url: string, headers: Record<string, string>, body: unknown): Promise<ArrayBuffer> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TTS HTTP ${res.status}: ${await res.text()}`);
  }
  return res.arrayBuffer();
}

const openai: TTSProvider = {
  id: "openai",
  available: () => Boolean(envKey("OPENAI_API_KEY") ?? envKey("VITE_OPENAI_API_KEY")),
  async synthesize(input) {
    const apiKey = envKey("OPENAI_API_KEY") ?? envKey("VITE_OPENAI_API_KEY");
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");
    return fetchAudio(
      "https://api.openai.com/v1/audio/speech",
      { Authorization: `Bearer ${apiKey}` },
      {
        model: input.model ?? "gpt-4o-mini-tts",
        input: input.text,
        voice: input.voice ?? "alloy",
        response_format: input.format ?? "mp3",
        speed: input.speed ?? 1.0,
      },
    );
  },
};

const azure: TTSProvider = {
  id: "azure",
  available: () => Boolean(envKey("SPEECH_KEY") && envKey("SPEECH_REGION")),
  async synthesize(input) {
    const key = envKey("SPEECH_KEY");
    const region = envKey("SPEECH_REGION");
    if (!key || !region) throw new Error("SPEECH_KEY / SPEECH_REGION not configured");
    const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-96kbitrate-mono-mp3",
      },
      body: `<speak version='1.0' xml:lang='en-US'><voice name='${input.voice ?? "en-US-AriaNeural"}'>${escapeXml(input.text)}</voice></speak>`,
    });
    if (!res.ok) throw new Error(`Azure TTS HTTP ${res.status}: ${await res.text()}`);
    return res.arrayBuffer();
  },
};

const elevenlabs: TTSProvider = {
  id: "elevenlabs",
  available: () => Boolean(envKey("ELEVENLABS_API_KEY")),
  async synthesize(input) {
    const apiKey = envKey("ELEVENLABS_API_KEY");
    if (!apiKey) throw new Error("ELEVENLABS_API_KEY not configured");
    const voice = input.voice ?? "21m00Tcm4TlvDq8ikWAM";
    return fetchAudio(
      `https://api.elevenlabs.io/v1/text-to-speech/${voice}`,
      { "xi-api-key": apiKey, Accept: "audio/mpeg" },
      { text: input.text, model_id: input.model ?? "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
    );
  },
};

const google: TTSProvider = {
  id: "google",
  available: () => Boolean(envKey("GOOGLE_API_KEY")),
  async synthesize(input) {
    const apiKey = envKey("GOOGLE_API_KEY");
    if (!apiKey) throw new Error("GOOGLE_API_KEY not configured");
    const res = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text: input.text },
          voice: { languageCode: "en-US", name: input.voice ?? "en-US-Neural2-F" },
          audioConfig: { audioEncoding: "MP3" },
        }),
      },
    );
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) throw new Error("Google TTS returned no audio");
    return Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0)).buffer;
  },
};

const deepgram: TTSProvider = {
  id: "deepgram",
  available: () => Boolean(envKey("DEEPGRAM_API_KEY")),
  async synthesize(input) {
    const apiKey = envKey("DEEPGRAM_API_KEY");
    if (!apiKey) throw new Error("DEEPGRAM_API_KEY not configured");
    return fetchAudio(
      "https://api.deepgram.com/v1/speak?model=tts-1&encoding=mp3",
      { Authorization: `Token ${apiKey}` },
      { text: input.text },
    );
  },
};

const cartesia: TTSProvider = {
  id: "cartesia",
  available: () => Boolean(envKey("CARTESIA_API_KEY")),
  async synthesize(input) {
    const apiKey = envKey("CARTESIA_API_KEY");
    if (!apiKey) throw new Error("CARTESIA_API_KEY not configured");
    return fetchAudio(
      "https://api.cartesia.ai/tts/bytes",
      { "Cartesia-Api-Key": apiKey, "Cartesia-Version": "2024-06-10" },
      { model_id: input.model ?? "sonic-english", transcript: input.text, voice: { mode: "id", id: input.voice ?? "a0e99841-438c-4a64-a679-ae501e7d6091" }, output_format: { container: "mp3", sample_rate: 24000 } },
    );
  },
};

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 11-provider breadth: direct where keys exist, otherwise managed runtime. */
export const BUILTIN_TTS_PROVIDERS: TTSProvider[] = [
  openai,
  azure,
  elevenlabs,
  google,
  deepgram,
  cartesia,
  managedRuntimeProvider("edge", "Edge TTS"),
  managedRuntimeProvider("gemini", "Gemini TTS"),
  managedRuntimeProvider("minimax", "MiniMax TTS"),
  managedRuntimeProvider("polly", "AWS Polly"),
  managedRuntimeProvider("xtts", "Coqui XTTS"),
];
