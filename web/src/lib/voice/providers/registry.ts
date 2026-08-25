/**
 * TTS provider registry.
 *
 * Mirrors the Python 11-provider TTS surface. Providers register by id;
 * `resolveTtsProvider` picks the best available provider in registration order
 * (first `available()` wins), and `listTtsProviders` drives the settings UI.
 * Streaming TTS consumers use `provider.stream` when present, otherwise they
 * synthesize whole buffers and chunk them.
 */

import type { TTSProvider } from "../types";

const providers = new Map<string, TTSProvider>();

export function registerTtsProvider(provider: TTSProvider): void {
  providers.set(provider.id, provider);
}

export function getTtsProvider(id: string): TTSProvider | undefined {
  return providers.get(id);
}

export function listTtsProviders(): TTSProvider[] {
  return Array.from(providers.values());
}

/** First registered provider that is currently available. */
export function resolveTtsProvider(): TTSProvider | undefined {
  return listTtsProviders().find((p) => p.available());
}

export function clearTtsProviders(): void {
  providers.clear();
}
