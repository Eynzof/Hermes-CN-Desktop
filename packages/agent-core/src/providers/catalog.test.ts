import { afterEach, describe, expect, it } from "vitest";
import { clearProviders, registerProvider } from "./registry.js";
import { createModelCatalogService } from "./catalog.js";
import type { ProviderProfile } from "./profile.js";

function fakeProvider(overrides: Partial<ProviderProfile> = {}): ProviderProfile {
  return {
    slug: "openai",
    name: "OpenAI",
    apiMode: "chat_completions",
    authKind: "api_key",
    ...overrides,
  };
}

describe("model catalog service", () => {
  afterEach(() => {
    clearProviders();
  });

  it("lists providers", () => {
    registerProvider(fakeProvider({ slug: "openai", name: "OpenAI" }));
    const svc = createModelCatalogService();
    expect(svc.listProviders()).toHaveLength(1);
    expect(svc.getProvider("openai")?.name).toBe("OpenAI");
  });

  it("lists models from fallbackModels", async () => {
    registerProvider(
      fakeProvider({
        slug: "openai",
        fallbackModels: ["gpt-4o", "gpt-4o-mini"],
      }),
    );
    const svc = createModelCatalogService();
    const models = await svc.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-4o");
    expect(models[0].provider).toBe("openai");
  });

  it("falls back to single advertised model", async () => {
    registerProvider(
      fakeProvider({
        slug: "anthropic",
        name: "Anthropic",
        model: "claude-opus-4-20250514",
      }),
    );
    const svc = createModelCatalogService();
    const models = await svc.listModels();
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("claude-opus-4-20250514");
  });

  it("resolves aliases", () => {
    const svc = createModelCatalogService();
    expect(svc.resolveAlias("claude-opus")).toEqual({
      provider: "anthropic",
      model: "claude-opus-4-20250514",
    });
  });

  it("persists default model via writeConfig hook", async () => {
    let saved: Record<string, unknown> | undefined;
    const svc = createModelCatalogService({
      writeConfig: async (patch) => {
        saved = patch;
      },
    });
    await svc.setDefaultModel("gpt-4o", "openai");
    expect(saved).toEqual({
      model: {
        default: "gpt-4o",
        provider: "openai",
      },
    });
  });

  it("refresh returns empty when fetchModels is absent", async () => {
    registerProvider(fakeProvider({ slug: "openai" }));
    const svc = createModelCatalogService();
    expect(await svc.refreshProviderModels("openai")).toEqual([]);
  });

  it("refresh fetches models from provider", async () => {
    registerProvider(
      fakeProvider({
        slug: "openai",
        baseUrl: "https://api.openai.com",
        fetchModels: async () => ["gpt-4o"],
      }),
    );
    const svc = createModelCatalogService();
    expect(await svc.refreshProviderModels("openai")).toEqual(["gpt-4o"]);
  });
});
