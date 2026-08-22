/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CN_BACKEND_PROVIDER_SLUGS } from "../cn-provider-slugs";
import {
  fetchModelsDev,
  getProviderInfo,
  getModelInfo,
  listAgenticModels,
  getModelCapabilities,
  lookupContextWindow,
  envKeyToProvider,
  CN_ENV_VAR_METADATA,
  HERMES_TO_MODELS_DEV,
} from "./index";

describe("models-dev", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("reads the bundled snapshot offline", async () => {
    const registry = await fetchModelsDev({ allowNetwork: false });
    expect(registry.providers.length).toBeGreaterThan(0);
    expect(registry.models.length).toBeGreaterThan(0);
  });

  it("looks up provider info", async () => {
    const provider = await getProviderInfo("volcengine-ark", { allowNetwork: false });
    expect(provider?.name).toBe("Volcengine Ark");
    expect(provider?.env).toContain("ARK_API_KEY");
  });

  it("looks up model info", async () => {
    const model = await getModelInfo("volcengine-ark", "doubao-pro-32k", { allowNetwork: false });
    expect(model?.name).toBe("Doubao Pro 32K");
    expect(model?.toolCall).toBe(true);
  });

  it("lists agentic models for a provider", async () => {
    const models = await listAgenticModels("siliconflow", { allowNetwork: false });
    expect(models).toContain("deepseek-v3");
    expect(models).not.toContain("deepseek-r1");
  });

  it("resolves capabilities", async () => {
    const caps = await getModelCapabilities("hunyuan", "hunyuan-standard-256k", { allowNetwork: false });
    expect(caps?.contextWindow).toBe(262144);
    expect(caps?.toolCall).toBe(true);
  });

  it("looks up context window", async () => {
    const window = await lookupContextWindow("qianfan", "ernie-4.0", { allowNetwork: false });
    expect(window).toBe(8192);
  });

  it("falls back to snapshot on network failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const registry = await fetchModelsDev({ allowNetwork: true });
    expect(registry.providers.length).toBeGreaterThan(0);
  });

  it("maps env keys to providers", () => {
    expect(envKeyToProvider("ARK_API_KEY")).toBe("volcengine-ark");
    expect(envKeyToProvider("SILICONFLOW_API_KEY")).toBe("siliconflow");
    expect(envKeyToProvider("AI302_API_KEY")).toBe("ai302");
    expect(envKeyToProvider("LONGCAT_API_KEY")).toBe("longcat");
    expect(envKeyToProvider("UNKNOWN")).toBeUndefined();
  });

  it("exposes CN env var metadata", () => {
    expect(CN_ENV_VAR_METADATA.ARK_API_KEY.password).toBe(true);
    expect(CN_ENV_VAR_METADATA.ARK_BASE_URL.password).toBe(false);
    for (const meta of Object.values(CN_ENV_VAR_METADATA)) {
      expect(meta.key).toBeDefined();
      expect(meta.description.length).toBeGreaterThan(0);
      expect(["provider", "tool", "messaging", "setting", "service"]).toContain(meta.category);
    }
  });

  it("HERMES_TO_MODELS_DEV covers every CN_BACKEND_PROVIDER_SLUGS entry", () => {
    // MoA is a virtual aggregate provider and intentionally has no models.dev ID.
    const virtualSlugs = new Set(["moa"]);
    for (const slug of CN_BACKEND_PROVIDER_SLUGS) {
      if (virtualSlugs.has(slug)) continue;
      expect(HERMES_TO_MODELS_DEV[slug], `missing models.dev mapping for ${slug}`).toBeDefined();
    }
  });
});
