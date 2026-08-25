import { beforeEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider, registerProvider } from "./registry.js";
import { registerBuiltinProviders, BUILTIN_PROVIDER_PROFILES } from "./builtin-profiles.js";
import { createCodexResponsesAdapter } from "./codex-responses.js";
import { createMiniMaxAdapter } from "./minimax.js";
import { createMoonshotAdapter } from "./moonshot.js";
import { createLMStudioAdapter } from "./lmstudio.js";
import { createNousRelayAdapter } from "./nous-relay.js";
import { createPluginLLMAdapter } from "./plugin-llm.js";
import { ProviderError } from "../errors.js";

describe("new provider adapters (P1-7)", () => {
  beforeEach(() => {
    clearProviders();
  });

  it("codex responses adapter defaults to gpt-5-codex on the OpenAI Responses endpoint", () => {
    const adapter = createCodexResponsesAdapter();
    expect(adapter.modelName).toBe("gpt-5-codex");
  });

  it("minimax/moonshot adapters default to their provider endpoints", () => {
    expect(createMiniMaxAdapter().modelName).toBe("MiniMax-M2");
    expect(createMoonshotAdapter().modelName).toBe("kimi-k2.5");
    expect(createLMStudioAdapter().modelName).toBe("local-model");
    expect(createNousRelayAdapter().modelName).toBe("nous-relay-default");
  });

  it("registerBuiltinProviders seeds all new provider slugs and is idempotent", () => {
    registerBuiltinProviders();
    for (const slug of [
      "openai",
      "anthropic",
      "codex-responses",
      "minimax",
      "moonshot",
      "lmstudio",
      "nous-relay",
    ]) {
      expect(getProvider(slug), `expected ${slug} to be registered`).toBeDefined();
    }
    const count = BUILTIN_PROVIDER_PROFILES.length;
    registerBuiltinProviders();
    // Registry is keyed by slug; re-registering replaces, never duplicates.
    expect(getProvider("openai")?.slug).toBe("openai");
    expect(count).toBeGreaterThanOrEqual(8);
  });

  it("createPluginLLMAdapter throws for an unregistered plugin provider", () => {
    expect(() => createPluginLLMAdapter({ model: "m", providerSlug: "ghost" })).toThrow(
      ProviderError,
    );
  });

  it("createPluginLLMAdapter delegates to chat adapter for chat_completions profiles", () => {
    registerProvider({
      slug: "custom",
      name: "Custom",
      apiMode: "chat_completions",
      authKind: "api_key",
      baseUrl: "https://custom.example/v1",
    });
    const adapter = createPluginLLMAdapter({ model: "m1", providerSlug: "custom" });
    expect(adapter.modelName).toBe("m1");
  });

  it("createPluginLLMAdapter delegates to responses adapter for codex_responses profiles", () => {
    registerProvider({
      slug: "custom-codex",
      name: "Custom Codex",
      apiMode: "codex_responses",
      authKind: "api_key",
      baseUrl: "https://custom.example/v1",
    });
    const adapter = createPluginLLMAdapter({ model: "m1", providerSlug: "custom-codex" });
    expect(adapter.modelName).toBe("m1");
  });
});
