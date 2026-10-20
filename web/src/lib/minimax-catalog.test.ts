import { describe, expect, it } from "vitest";
import {
  BUILTIN_PROVIDER_CATALOG, buildProviderConfigUpdate, buildProviderSettingsUpdate, mergeProviderCatalog,
} from "./provider-catalog";

const preset = BUILTIN_PROVIDER_CATALOG.providers.find((entry) => entry.id === "minimax-cn")!;

describe("MiniMax catalog refresh", () => {
  it("prevents a stale remote catalog from replacing current ordinary choices", () => {
    const remote = {
      version: "stale",
      providers: [{ ...preset, defaultModel: "MiniMax-M2.7", models: [
        { id: "MiniMax-M2.7" },
        { id: "MiniMax-M3", supportsVision: true },
      ] }],
    };
    const merged = mergeProviderCatalog(BUILTIN_PROVIDER_CATALOG, remote);
    const current = merged.providers.find((entry) => entry.id === preset.id)!;
    expect(current.defaultModel).toBe("MiniMax-M3.1-Flash");
    expect(current.models.map((entry) => entry.id)).toEqual(["MiniMax-M3.1-Flash", "MiniMax-M3"]);
    expect(current.models[0].contextWindow).toBe(1_000_000);
    expect(current.models[1].supportsVision).toBe(true);
    expect(remote.providers[0].defaultModel).toBe("MiniMax-M2.7");
    for (const provider of BUILTIN_PROVIDER_CATALOG.providers) {
      if (provider.id !== preset.id) expect(merged.providers.find((entry) => entry.id === provider.id)).toEqual(provider);
    }
  });

  it("defaults new configuration to Flash without overwriting saved legacy model metadata or media", () => {
    const input = { apiKey: "", baseUrl: "", model: "" };
    expect(buildProviderConfigUpdate({}, preset, input).model.default).toBe("MiniMax-M3.1-Flash");
    const config = {
      providers: { "minimax-cn": { model: "MiniMax-M2.7", models: {
        "MiniMax-M2.7": { context_length: 204800, supports_vision: false },
        "private-model": { context_length: 8192 },
        "MiniMax-M3": { supports_vision: true, supports_video: true },
      } } },
      model: { default: "MiniMax-M2.7", provider: "minimax-cn" },
      tts: { provider: "minimax", minimax: { model: "saved-speech-model" } },
    };
    const updated = buildProviderSettingsUpdate(config, preset, input);
    expect(updated.providers["minimax-cn"].model).toBe("MiniMax-M2.7");
    expect(updated.providers["minimax-cn"].models["MiniMax-M2.7"])
      .toEqual(config.providers["minimax-cn"].models["MiniMax-M2.7"]);
    expect(updated.providers["minimax-cn"].models["private-model"])
      .toEqual(config.providers["minimax-cn"].models["private-model"]);
    expect(updated.providers["minimax-cn"].models["MiniMax-M3"])
      .toMatchObject({ supports_vision: true, supports_video: true });
    expect(updated.model).toEqual(config.model);
    expect(updated.tts).toEqual(config.tts);
  });
});
