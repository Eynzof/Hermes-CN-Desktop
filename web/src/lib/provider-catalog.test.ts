import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildCurrentModelConfigUpdate,
  buildProviderConfigUpdate,
  buildProviderSettingsUpdate,
  fetchRemoteProviderCatalog,
  getProviderEntry,
  providerHasSavedCredentials,
  sortProvidersForCnEdition,
  TOP5_PROVIDER_IDS,
  type ProviderPreset,
} from "./provider-catalog";

vi.mock("./transport", () => ({
  fetchExternalJSON: vi.fn(),
}));

const mockedFetchExternalJSON = vi.mocked(fetchExternalJSON);

beforeEach(() => {
  mockedFetchExternalJSON.mockReset();
});

describe("provider catalog config updates", () => {
  it("writes catalog providers as canonical providers instead of custom slugs", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "cp.compshare.cn");
    expect(preset).toBeTruthy();

    const config = buildProviderConfigUpdate(
      { model: "old-model" },
      preset!,
      {
        apiKey: "test-key",
        baseUrl: "https://cp.compshare.cn/v1",
        model: "glm-5.1",
      },
    );

    expect(config.model).toMatchObject({
      provider: "cp.compshare.cn",
      default: "glm-5.1",
      base_url: "https://cp.compshare.cn/v1",
      api_mode: "chat_completions",
    });
    expect(config.providers["cp.compshare.cn"]).toMatchObject({
      name: "优云智算 · Agent Plan",
      api_key: "test-key",
      model: "glm-5.1",
    });
    expect(config.model.provider).not.toMatch(/^custom:/);
  });

  it("can save provider settings without changing the current model", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "kimi-for-coding");
    expect(preset).toBeTruthy();

    const config = buildProviderSettingsUpdate(
      {
        model: {
          provider: "deepseek",
          default: "deepseek-v4-flash",
        },
      },
      preset!,
      {
        apiKey: "kimi-key",
        baseUrl: "https://api.moonshot.cn/v1",
        model: "kimi-k2.6",
      },
    );

    expect(config.providers["kimi-for-coding"]).toMatchObject({
      api_key: "kimi-key",
      model: "kimi-k2.6",
      base_url: "https://api.moonshot.cn/v1",
    });
    expect(config.model).toEqual({
      provider: "deepseek",
      default: "deepseek-v4-flash",
    });
  });

  it("can set the current model without rewriting provider metadata", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "kimi-for-coding");
    expect(preset).toBeTruthy();

    const config = buildCurrentModelConfigUpdate(
      {
        providers: {
          "kimi-for-coding": {
            api_key: "saved-key",
            base_url: "https://api.moonshot.cn/v1",
            model: "kimi-k2.6",
          },
        },
      },
      preset!,
      {
        apiKey: "",
        baseUrl: "",
        model: "kimi-k2.6",
      },
    );

    expect(config.providers["kimi-for-coding"]).toEqual({
      api_key: "saved-key",
      base_url: "https://api.moonshot.cn/v1",
      model: "kimi-k2.6",
    });
    expect(config.model).toMatchObject({
      provider: "kimi-for-coding",
      default: "kimi-k2.6",
      base_url: "https://api.moonshot.cn/v1",
      api_mode: "chat_completions",
    });
  });

  it.each(TOP5_PROVIDER_IDS)("ships featured CN provider %s with intact required fields", (id) => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((p) => p.id === id);
    expect(preset, `Featured CN provider "${id}" must exist in BUILTIN_PROVIDER_CATALOG`).toBeTruthy();
    expect(preset!.name).toBeTruthy();
    expect(preset!.baseUrl).toMatch(/^https?:\/\//);
    expect(preset!.docsUrl, `${id} should expose a docs URL for the CN edition`).toMatch(/^https?:\/\//);
    expect(preset!.defaultModel).toBeTruthy();
    expect(preset!.region, `${id} is a Chinese-edition feature provider`).toBe("cn");
    expect(
      preset!.models.some((m) => m.id === preset!.defaultModel),
      `${id}.defaultModel "${preset!.defaultModel}" must appear in models[]`,
    ).toBe(true);
  });

  it("ships direct CN providers without 302.AI and keeps OpenRouter as the explicit aggregator", () => {
    const ids = BUILTIN_PROVIDER_CATALOG.providers.map((provider) => provider.id);

    expect(ids).not.toContain("ai302");
    expect(ids).toContain("openrouter");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps plan-specific endpoints separate from pay-as-you-go endpoints", () => {
    const byId = new Map(BUILTIN_PROVIDER_CATALOG.providers.map((provider) => [provider.id, provider]));

    expect(byId.get("modelverse")).toMatchObject({
      name: "优云智算 · API 按量付费",
      baseUrl: "https://api.modelverse.cn/v1",
    });
    expect(byId.get("cp.compshare.cn")).toMatchObject({
      name: "优云智算 · Agent Plan",
      baseUrl: "https://cp.compshare.cn/v1",
      supportsModelListing: false,
    });

    expect(byId.get("alibaba")).toMatchObject({
      name: "阿里云百炼 · API 按量付费",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    expect(byId.get("alibaba-coding-cn")).toMatchObject({
      name: "阿里云百炼 · Coding Plan",
      baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
      defaultModel: "qwen3-coder-plus",
      supportsModelListing: false,
    });

    expect(byId.get("zai")).toMatchObject({
      name: "智谱 GLM · API 按量付费",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    });
    expect(byId.get("zai-coding-cn")).toMatchObject({
      name: "智谱 GLM · Coding Plan",
      baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
      defaultModel: "glm-5.1",
      supportsModelListing: false,
    });

    expect(byId.get("volcengine-ark")).toMatchObject({
      name: "火山方舟 · API 按量付费",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    });
    expect(byId.get("volcengine-ark-coding")).toMatchObject({
      name: "火山方舟 · Coding Plan",
      baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
      defaultModel: "ark-code-latest",
      supportsModelListing: false,
    });

    expect(byId.get("stepfun")).toMatchObject({
      name: "阶跃星辰 · API 按量付费",
      baseUrl: "https://api.stepfun.com/v1",
    });
    expect(byId.get("stepfun-step-plan")).toMatchObject({
      name: "阶跃星辰 · Step Plan",
      baseUrl: "https://api.stepfun.ai/step_plan/v1",
      defaultModel: "step-3.7-flash",
      supportsModelListing: false,
    });

    expect(byId.get("minimax-cn")).toMatchObject({
      name: "MiniMax · Token Plan",
      baseUrl: "https://api.minimaxi.com/anthropic",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      supportsModelListing: false,
    });
  });

  it("orders featured CN providers first, then other CN, then global", () => {
    const sorted = sortProvidersForCnEdition(BUILTIN_PROVIDER_CATALOG.providers);
    const sortedIds = sorted.map((p) => p.id);
    expect(sortedIds.slice(0, TOP5_PROVIDER_IDS.length)).toEqual([...TOP5_PROVIDER_IDS]);
    const remainder = sorted.slice(TOP5_PROVIDER_IDS.length);
    const firstGlobalIdx = remainder.findIndex((p) => p.region === "global");
    if (firstGlobalIdx !== -1) {
      const cnAfterGlobal = remainder.slice(firstGlobalIdx).some((p) => p.region === "cn");
      expect(cnAfterGlobal, "no cn-region provider should come after a global provider").toBe(false);
    }
  });

  it("places injected custom providers among the catalog without disturbing featured provider order", () => {
    const custom: ProviderPreset = {
      id: "custom:hunyuan-cloud-tencent-com",
      name: "腾讯混元（自定义）",
      vendor: "自定义",
      region: "cn",
      baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: "hunyuan-turbos-latest",
      models: [{ id: "hunyuan-turbos-latest", supportsTools: true }],
      isCustom: true,
    };
    const sorted = sortProvidersForCnEdition([...BUILTIN_PROVIDER_CATALOG.providers, custom]);
    expect(sorted.slice(0, TOP5_PROVIDER_IDS.length).map((p) => p.id)).toEqual([...TOP5_PROVIDER_IDS]);
    expect(sorted.find((p) => p.id === custom.id)).toBeTruthy();
  });

  it("preserves an existing provider key when saving metadata only", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers[0]!;
    const config = buildProviderConfigUpdate(
      {
        providers: {
          [preset.id]: {
            api_key: "existing-key",
            base_url: "https://old.example/v1",
          },
        },
      },
      preset,
      {
        apiKey: "",
        baseUrl: preset.baseUrl,
        model: preset.defaultModel,
      },
    );

    expect(getProviderEntry(config, preset.id).api_key).toBe("existing-key");
    expect(providerHasSavedCredentials(config, preset.id)).toBe(true);
  });

  it("loads remote catalog through fetchExternalJSON timeout path", async () => {
    mockedFetchExternalJSON.mockResolvedValue({
      version: "remote-v1",
      providers: [
        {
          id: "remote-provider",
          name: "Remote Provider",
          vendor: "Remote",
          region: "global",
          baseUrl: "https://api.example.com/v1",
          apiMode: "chat_completions",
          transport: "openai_chat",
          apiKeyLabel: "REMOTE_API_KEY",
          defaultModel: "remote-model",
          models: [{ id: "remote-model" }],
        },
      ],
    });

    const catalog = await fetchRemoteProviderCatalog("https://cdn.example.com/catalog.json");

    expect(mockedFetchExternalJSON).toHaveBeenCalledWith(
      "https://cdn.example.com/catalog.json",
      { headers: { Accept: "application/json" } },
    );
    expect(catalog).toMatchObject({
      version: "remote-v1",
      providers: [
        {
          id: "remote-provider",
          defaultModel: "remote-model",
        },
      ],
    });
  });
});
