import { afterEach, describe, expect, it } from "vitest";
import { clearProviders, getProvider, listProviders } from "../providers/registry.js";
import { manifestToModelProviderPlugin, registerModelProviderPlugin } from "./provider-plugin.js";
import type { PluginManifest } from "./types.js";

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

describe("manifestToModelProviderPlugin", () => {
  it("builds a plugin from a manifest and profile body", () => {
    const manifest: PluginManifest = {
      name: "custom-openai",
      title: "Custom OpenAI",
      version: "1.0.0",
      kind: "model-provider",
    };
    const plugin = manifestToModelProviderPlugin(manifest, {
      apiMode: "chat_completions",
      authKind: "api_key",
      baseUrl: "https://example.com",
      model: "m1",
      fallbackModels: ["f1"],
      capabilities: { streaming: true, supportsTools: true },
    });
    expect(plugin.slug).toBe("custom-openai");
    expect(plugin.name).toBe("Custom OpenAI");
    expect(plugin.apiMode).toBe("chat_completions");
    expect(plugin.authKind).toBe("api_key");
    expect(plugin.baseUrl).toBe("https://example.com");
    expect(plugin.model).toBe("m1");
    expect(plugin.fallbackModels).toEqual(["f1"]);
    expect(plugin.capabilities).toEqual({ streaming: true, supportsTools: true });
  });

  it("falls back to the manifest name as display name", () => {
    const plugin = manifestToModelProviderPlugin(
      { name: "plain", version: "1.0.0", kind: "model-provider" },
      { apiMode: "chat_completions", authKind: "api_key" },
    );
    expect(plugin.name).toBe("plain");
  });

  it("produces a plugin that can be registered", () => {
    const manifest: PluginManifest = {
      name: "reg",
      title: "Reg",
      version: "1.0.0",
      kind: "model-provider",
    };
    const plugin = manifestToModelProviderPlugin(manifest, {
      apiMode: "chat_completions",
      authKind: "api_key",
    });
    registerModelProviderPlugin(plugin);
    expect(getProvider("reg")?.name).toBe("Reg");
  });
});
