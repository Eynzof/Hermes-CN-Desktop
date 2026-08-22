/**
 * Voice / TTS shared types.
 */

export interface TTSSynthesisResult {
  data: ArrayBuffer;
  mimeType: string;
  provider: string;
}

export interface TTSProvider {
  id: string;
  available(): boolean;
  synthesize(input: {
    text: string;
    format?: "mp3" | "ogg" | "wav" | "opus" | "pcm";
    voice?: string;
    model?: string;
    speed?: number;
  }): Promise<ArrayBuffer>;
  stream?(text: string, signal: AbortSignal): AsyncIterable<Uint8Array>;
}

export interface AudioSpeakResult {
  ok: boolean;
  data_url: string;
  mime_type: string;
  provider: string;
  duration_ms?: number;
  peaks?: number[];
}

export interface TtsEngine {
  speak(text: string, opts?: { provider?: string; voice?: string; model?: string }): Promise<AudioSpeakResult>;
  streamSpeak(deltas: AsyncIterable<string>, signal: AbortSignal): Promise<void>;
}
