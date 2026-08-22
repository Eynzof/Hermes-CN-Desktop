/**
 * TTS / Voice Messages — TtsEngine facade.
 *
 * Keeps the same `speakText` return shape as the existing `/api/audio/speak`
 * REST bridge while dispatching to in-process TTS providers.
 */

import type { AudioSpeakResult, TTSProvider, TtsEngine } from "./types";
import { OpenAiTtsProvider } from "./providers/openai";
import { createPlaybackEngine } from "./playback";
import { prepareSpokenText } from "./normalize";
import { computeWaveformPeaks } from "./waveform";

const providers: TTSProvider[] = [new OpenAiTtsProvider()];

function resolveProvider(preferred?: string): TTSProvider | undefined {
  if (preferred) {
    return providers.find((p) => p.id === preferred);
  }
  return providers.find((p) => p.available()) ?? providers[0];
}

function arrayBufferToDataUrl(buffer: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function decodeAudioDurationMs(buffer: ArrayBuffer, mimeType: string): Promise<number | undefined> {
  if (typeof AudioContext === "undefined") return undefined;
  try {
    const ctx = new AudioContext();
    const decoded = await ctx.decodeAudioData(buffer.slice(0));
    return Math.round(decoded.duration * 1000);
  } catch {
    return undefined;
  }
}

export function createTtsEngine(): TtsEngine {
  const playback = createPlaybackEngine();

  return {
    async speak(text, opts = {}) {
      const provider = resolveProvider(opts.provider);
      if (!provider || !provider.available()) {
        throw new Error("no tts provider available");
      }

      const spoken = prepareSpokenText(text);
      if (!spoken) throw new Error("text is required");

      const audio = await provider.synthesize({
        text: spoken,
        voice: opts.voice,
        model: opts.model,
      });

      const mimeType = provider.id === "openai" ? "audio/mpeg" : "audio/mpeg";
      const durationMs = await decodeAudioDurationMs(audio, mimeType);
      const dataUrl = arrayBufferToDataUrl(audio, mimeType);

      // Decode for optional waveform peaks.
      let peaks: number[] | undefined;
      try {
        if (typeof AudioContext !== "undefined") {
          const ctx = new AudioContext();
          const decoded = await ctx.decodeAudioData(audio.slice(0));
          peaks = computeWaveformPeaks(decoded.getChannelData(0), { samples: 60 });
        }
      } catch {
        // peaks are optional
      }

      return {
        ok: true,
        data_url: dataUrl,
        mime_type: mimeType,
        provider: provider.id,
        duration_ms: durationMs,
        peaks,
      };
    },

    async streamSpeak(deltas, signal) {
      const provider = resolveProvider("openai");
      if (!provider?.stream) {
        throw new Error("streaming tts not available");
      }
      playback.stop();
      for await (const chunk of provider.stream("", signal)) {
        // PCM chunks would be decoded and queued here; this is a scaffold.
        if (signal.aborted) break;
      }
    },
  };
}

export const ttsEngine = createTtsEngine();
