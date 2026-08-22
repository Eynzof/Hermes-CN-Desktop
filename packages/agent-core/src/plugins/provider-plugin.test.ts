import { afterEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider, listProviders } from "../providers/registry.js";
import { registerModelProviderPlugin } from "./provider-plugin.js";

describe("registerModelProviderPlugin", () => {
  afterEach(() => {
    clearProviders();
  });

  it("registers a model provider plugin as a ProviderProfile", () => {
    registerModelProviderPlugin({
      slug: "custom-openai",
      name: "Custom OpenAI",
      apiMode: "chat_completions",
      authKind: "api_key",
      baseUrl: "https://api.example.com",
      model: "example-model",
      fallbackModels: ["fallback-1"],
      capabilities: { streaming: true, supportsTools: true },
    });

    const profile = getProvider("custom-openai");
    expect(profile).toBeDefined();
    expect(profile?.name).toBe("Custom OpenAI");
    expect(profile?.apiMode).toBe("chat_completions");
    expect(profile?.baseUrl).toBe("https://api.example.com");
    expect(listProviders()).toHaveLength(1);
  });
});
