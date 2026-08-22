/**
 * TTS / Voice Messages — OpenAI TTS provider.
 */

import type { TTSProvider } from "../types";

export function getOpenAiApiKey(): string | undefined {
  return (
    import.meta.env.VITE_OPENAI_API_KEY ||
    import.meta.env.VITE_VOICE_TOOLS_OPENAI_KEY ||
    (typeof window !== "undefined" ? (window as unknown as { OPENAI_API_KEY?: string; VOICE_TOOLS_OPENAI_KEY?: string }).OPENAI_API_KEY : undefined)
  );
}

export class OpenAiTtsProvider implements TTSProvider {
  readonly id = "openai";

  available(): boolean {
    return Boolean(getOpenAiApiKey());
  }

  async synthesize(input: {
    text: string;
    format?: "mp3" | "ogg" | "wav" | "opus" | "pcm";
    voice?: string;
    model?: string;
    speed?: number;
  }): Promise<ArrayBuffer> {
    const apiKey = getOpenAiApiKey();
    if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

    const response = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: input.model || "gpt-4o-mini-tts",
        input: input.text,
        voice: input.voice || "alloy",
        response_format: input.format === "opus" ? "opus" : input.format === "pcm" ? "pcm" : "mp3",
        speed: input.speed ?? 1.0,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS error: ${response.status} ${text}`);
    }

    return response.arrayBuffer();
  }
}
