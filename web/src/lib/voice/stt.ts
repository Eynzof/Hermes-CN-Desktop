/**
 * Voice Mode — STT client interface.
 */

export interface TranscriptionResult {
  transcript: string;
  provider: string;
}

export interface SttProvider {
  id: string;
  transcribe(pcm: Int16Array | Blob, opts?: { language?: string; prompt?: string }): Promise<TranscriptionResult>;
}

export interface SttConfig {
  provider: "local" | "groq" | "openai";
  language?: string;
  model?: string;
}

export function resolveSttProvider(
  providers: SttProvider[],
  config?: SttConfig,
): SttProvider | undefined {
  if (!config?.provider) return providers.find((p) => p.id === "local") ?? providers[0];
  return providers.find((p) => p.id === config.provider);
}
