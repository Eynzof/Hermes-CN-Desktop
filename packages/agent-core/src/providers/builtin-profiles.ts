/**
 * Built-in provider profiles for the desktop's own adapter set.
 *
 * The consumer-facing catalog (`providers/catalog.ts`) and `/model` switch
 * (`providers/switch.ts`) read from the shared provider registry. This module
 * seeds the registry with the providers the desktop implements natively so the
 * UI and the in-process runtime see them without a separate config source.
 *
 * Calling `registerBuiltinProviders()` is idempotent (registry is keyed by
 * slug) and safe from both the web app bootstrap and tests.
 */

import { registerProvider } from "./registry.js";
import type { ProviderProfile } from "./profile.js";

export const BUILTIN_PROVIDER_PROFILES: ProviderProfile[] = [
  {
    slug: "openai",
    name: "OpenAI",
    apiMode: "chat_completions",
    authKind: "api_key",
    baseUrl: "https://api.openai.com/v1",
    modelsUrl: "https://api.openai.com/v1/models",
    model: "gpt-4.1",
    fallbackModels: ["gpt-4.1", "gpt-4o", "o4-mini"],
    capabilities: { streaming: true, supportsTools: true, supportsVision: true, supportsReasoning: true },
  },
  {
    slug: "anthropic",
    name: "Anthropic",
    apiMode: "anthropic_messages",
    authKind: "api_key",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    fallbackModels: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-4-20250514"],
    capabilities: { streaming: true, supportsTools: true, supportsVision: true, supportsReasoning: true },
  },
  {
    slug: "google",
    name: "Google Gemini",
    apiMode: "chat_completions",
    authKind: "api_key",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-pro",
    fallbackModels: ["gemini-2.5-pro", "gemini-2.5-flash"],
    capabilities: { streaming: true, supportsTools: true, supportsVision: true },
  },
  {
    slug: "codex-responses",
    name: "Codex Responses",
    apiMode: "codex_responses",
    authKind: "api_key",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-codex",
    fallbackModels: ["gpt-5-codex", "codex-mini-latest"],
    capabilities: { streaming: true, supportsTools: true, supportsReasoning: true },
  },
  {
    slug: "minimax",
    name: "MiniMax",
    apiMode: "chat_completions",
    authKind: "api_key",
    baseUrl: "https://api.minimax.io/v1",
    model: "MiniMax-M2",
    fallbackModels: ["MiniMax-M2", "MiniMax-Text-01"],
    capabilities: { streaming: true, supportsTools: true },
  },
  {
    slug: "moonshot",
    name: "Moonshot (Kimi)",
    apiMode: "chat_completions",
    authKind: "api_key",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "kimi-k2.5",
    fallbackModels: ["kimi-k2.5", "kimi-k2", "moonshot-v1-128k"],
    capabilities: { streaming: true, supportsTools: true, supportsReasoning: true },
  },
  {
    slug: "lmstudio",
    name: "LM Studio",
    apiMode: "chat_completions",
    authKind: "none",
    baseUrl: "http://localhost:1234/v1",
    model: "local-model",
    capabilities: { streaming: true, supportsTools: true },
  },
  {
    slug: "nous-relay",
    name: "Nous Portal Relay",
    apiMode: "chat_completions",
    authKind: "api_key",
    baseUrl: "https://relay.nousresearch.com/v1",
    model: "nous-relay-default",
    capabilities: { streaming: true, supportsTools: true, supportsVision: true },
  },
];

/** Register every built-in provider profile (idempotent). */
export function registerBuiltinProviders(): void {
  for (const profile of BUILTIN_PROVIDER_PROFILES) {
    registerProvider(profile);
  }
}
