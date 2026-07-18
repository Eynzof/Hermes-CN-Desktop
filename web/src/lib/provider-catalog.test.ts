import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchExternalJSON } from "./transport";
import {
  BUILTIN_PROVIDER_CATALOG,
  buildCurrentModelConfigUpdate,
  buildCustomProviderDeleteUpdate,
  buildProviderConfigUpdate,
  buildProviderOrderUpdate,
  buildProviderSettingsUpdate,
  apiModeBadgeLabel,
  apiModeDisplayName,
  chatEndpointPreviewUrl,
  customProviderPresetsFromConfig,
  detectCustomApiModeFromUrl,
  fetchRemoteProviderCatalog,
  mergeProviderCatalog,
  getProviderCredentialPreview,
  getProviderEntry,
  getProviderOrder,
  maskSecretPreview,
  parseContextWindowInput,
  providerApiKeyLabels,
  providerHasSavedCredentials,
  resolveSelectedProvider,
  sortProvidersForCnEdition,
  sortProvidersForModelsPage,
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
  it("shows CLI custom_providers and uses the active model when the entry has no model", () => {
    const config = {
      model: "claude-opus-4-8",
      providers: {},
      custom_providers: [
        {
          name: "zijian",
          base_url: "https://example.test/anthropic",
          api_key: "test-key",
          api_mode: "anthropic_messages",
        },
      ],
    };

    const presets = customProviderPresetsFromConfig(
      config,
      BUILTIN_PROVIDER_CATALOG.providers,
      { provider: "custom:zijian", model: "claude-opus-4-8" },
    );

    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      id: "custom:zijian",
      name: "zijian",
      apiMode: "anthropic_messages",
      transport: "anthropic_messages",
      defaultModel: "claude-opus-4-8",
      isCustom: true,
    });
    expect(getProviderEntry(config, "custom:zijian")).toMatchObject({
      name: "zijian",
      api_key: "test-key",
    });
    expect(providerHasSavedCredentials(config, "custom:zijian", {}, presets[0])).toBe(true);
  });

  it("normalizes bare providers keys to the runtime custom slug and deduplicates legacy entries", () => {
    const presets = customProviderPresetsFromConfig(
      {
        providers: {
          zijian: {
            name: "Zijian New",
            base_url: "https://example.test/v1",
            default_model: "new-model",
          },
        },
        custom_providers: [
          {
            name: "zijian",
            base_url: "https://legacy.example.test/v1",
            model: "legacy-model",
          },
        ],
      },
      BUILTIN_PROVIDER_CATALOG.providers,
    );

    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({
      id: "custom:zijian",
      name: "Zijian New",
      defaultModel: "new-model",
    });
  });

  it("prefers the runtime provider until the user explicitly selects a card", () => {
    const custom = customProviderPresetsFromConfig(
      {
        custom_providers: [{ name: "zijian", base_url: "https://example.test/v1" }],
      },
      BUILTIN_PROVIDER_CATALOG.providers,
      { provider: "custom:zijian", model: "claude-opus-4-8" },
    )[0]!;
    const providers = [...BUILTIN_PROVIDER_CATALOG.providers, custom];

    expect(resolveSelectedProvider(providers, "", "custom:zijian")?.id).toBe("custom:zijian");
    expect(resolveSelectedProvider(providers, "deepseek", "custom:zijian")?.id).toBe("deepseek");
  });

  it("updates and deletes a legacy custom provider without creating a duplicate providers entry", () => {
    const config = {
      model: "claude-opus-4-8",
      providers: {},
      custom_providers: [
        {
          name: "zijian",
          base_url: "https://old.example.test/anthropic",
          api_key: "existing-key",
          api_mode: "anthropic_messages",
        },
      ],
    };
    const preset = customProviderPresetsFromConfig(
      config,
      BUILTIN_PROVIDER_CATALOG.providers,
      { provider: "custom:zijian", model: "claude-opus-4-8" },
    )[0]!;

    const updated = buildProviderSettingsUpdate(config, preset, {
      apiKey: "",
      baseUrl: "https://new.example.test/anthropic",
      model: "claude-opus-4-8",
    });

    expect(updated.providers).toEqual({});
    expect(updated.custom_providers).toHaveLength(1);
    expect(updated.custom_providers[0]).toMatchObject({
      name: "zijian",
      base_url: "https://new.example.test/anthropic",
      api_key: "existing-key",
      model: "claude-opus-4-8",
    });

    const removed = buildCustomProviderDeleteUpdate(updated, "custom:zijian");
    expect(removed.custom_providers).toEqual([]);
    expect(removed.providers).toEqual({});
  });

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


  it("writes Volcengine Coding Plan as a resolvable provider and current model", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "volcengine-ark-coding");
    expect(preset).toBeTruthy();

    const config = buildProviderConfigUpdate(
      {},
      preset!,
      {
        apiKey: "ark-coding-key",
        baseUrl: "https://ark.cn-beijing.volces.com/api/coding/v3",
        model: "doubao-seed-2.0-code",
      },
    );

    expect(config.providers["volcengine-ark-coding"]).toMatchObject({
      name: "火山方舟 · Coding Plan",
      api_key: "ark-coding-key",
      base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
      api_mode: "chat_completions",
      transport: "openai_chat",
      model: "doubao-seed-2.0-code",
    });
    expect(config.model).toMatchObject({
      provider: "volcengine-ark-coding",
      default: "doubao-seed-2.0-code",
      base_url: "https://ark.cn-beijing.volces.com/api/coding/v3",
      api_mode: "chat_completions",
      api_key: "ark-coding-key",
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

  it.each([
    ["gemini", "https://generativelanguage.googleapis.com/v1beta", "chat_completions", "openai_chat", "GEMINI_API_KEY", "gemini-3.5-flash"],
    ["openai-api", "https://api.openai.com/v1", "codex_responses", "codex_responses", "OPENAI_API_KEY", "gpt-5.6-sol"],
    ["anthropic", "https://api.anthropic.com", "anthropic_messages", "anthropic_messages", "ANTHROPIC_API_KEY", "claude-opus-4-8"],
    ["xai", "https://api.x.ai/v1", "codex_responses", "codex_responses", "XAI_API_KEY", "grok-build-0.1"],
  ])("ships global first-party provider %s with Core-compatible wire settings", (
    id,
    baseUrl,
    apiMode,
    transport,
    apiKeyLabel,
    defaultModel,
  ) => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === id);

    expect(preset).toMatchObject({
      id,
      region: "global",
      baseUrl,
      apiMode,
      transport,
      apiKeyLabel,
      defaultModel,
    });
    expect(preset!.models.some((model) => model.id === defaultModel)).toBe(true);

    const updated = buildProviderConfigUpdate({}, preset!, {
      apiKey: "provider-key",
      baseUrl,
      model: defaultModel,
    });
    expect(updated.model).toMatchObject({
      provider: id,
      default: defaultModel,
      base_url: baseUrl,
      api_mode: apiMode,
    });
  });

  it("recognizes canonical and compatibility API-key names for Gemini and Anthropic", () => {
    const byId = new Map(BUILTIN_PROVIDER_CATALOG.providers.map((provider) => [provider.id, provider]));

    expect(providerApiKeyLabels(byId.get("gemini")!)).toEqual(["GEMINI_API_KEY", "GOOGLE_API_KEY"]);
    expect(providerApiKeyLabels(byId.get("anthropic")!)).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ]);
    expect(byId.get("gemini")!.supportsModelListing).toBe(false);
    expect(byId.get("anthropic")!.supportsModelListing).toBe(true);
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
      defaultModel: "doubao-seed-2-0-lite-260428",
      supportsModelListing: false,
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
      defaultModel: "MiniMax-M3",
      supportsModelListing: false,
    });
  });

  it("ships MiniMax-M3 in the Token Plan preset with a 1M context window", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "minimax-cn");
    expect(preset).toBeTruthy();

    const m3 = preset!.models.find((model) => model.id === "MiniMax-M3");
    expect(m3).toMatchObject({
      contextWindow: 1_000_000,
      supportsTools: true,
      supportsReasoning: true,
    });
    expect(preset!.models[0]?.id).toBe("MiniMax-M3");

    const config = buildProviderSettingsUpdate(
      {},
      preset!,
      {
        apiKey: "minimax-key",
        baseUrl: "",
        model: "MiniMax-M3",
      },
    );

    expect(config.providers["minimax-cn"].models["MiniMax-M3"]).toMatchObject({
      context_length: 1_000_000,
      supports_tools: true,
      supports_reasoning: true,
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

  it("applies user provider order before appending new catalog providers", () => {
    const custom: ProviderPreset = {
      id: "custom:local",
      name: "Local",
      vendor: "本地部署",
      region: "cn",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: "local-model",
      models: [{ id: "local-model" }],
      isCustom: true,
    };
    const config = {
      desktop: {
        models: {
          provider_order: ["custom:local", "deepseek", "missing", "deepseek"],
        },
      },
    };

    const sorted = sortProvidersForModelsPage([...BUILTIN_PROVIDER_CATALOG.providers, custom], config);

    expect(getProviderOrder(config)).toEqual(["custom:local", "deepseek", "missing"]);
    expect(sorted.slice(0, 2).map((provider) => provider.id)).toEqual(["custom:local", "deepseek"]);
    expect(sorted.some((provider) => provider.id === "missing")).toBe(false);
  });

  it("writes provider order under desktop model preferences", () => {
    const next = buildProviderOrderUpdate(
      {
        desktop: {
          models: {
            provider_order: ["old"],
            density: "compact",
          },
          yoloMode: false,
        },
      },
      ["deepseek", "deepseek", "custom:local", ""],
    );

    expect(next.desktop.models).toMatchObject({
      density: "compact",
      provider_order: ["deepseek", "custom:local"],
    });
    expect(next.desktop.yoloMode).toBe(false);
  });

  it("deletes custom providers and resets auxiliary slots that reference them", () => {
    const config = {
      model: {
        provider: "deepseek",
        default: "deepseek-v4-flash",
      },
      providers: {
        deepseek: { model: "deepseek-v4-flash" },
        "custom:local": {
          name: "Local",
          base_url: "http://127.0.0.1:1234/v1",
          model: "local-model",
          api_key: "local-key",
        },
      },
      desktop: {
        models: {
          provider_order: ["custom:local", "deepseek"],
        },
      },
      auxiliary: {
        vision: {
          provider: "custom:local",
          model: "local-vl",
          base_url: "http://127.0.0.1:1234/v1",
          api_key: "aux-key",
          timeout: 120,
          download_timeout: 30,
        },
        compression: {
          provider: "deepseek",
          model: "deepseek-v4-flash",
        },
      },
    };

    const next = buildCustomProviderDeleteUpdate(config, "custom:local");

    expect(next.providers).not.toHaveProperty("custom:local");
    expect(next.desktop.models.provider_order).toEqual(["deepseek"]);
    expect(next.auxiliary.vision).toMatchObject({
      provider: "auto",
      model: "",
      base_url: "",
      extra_body: {},
      timeout: 120,
      download_timeout: 30,
    });
    expect(next.auxiliary.vision).not.toHaveProperty("api_key");
    expect(next.auxiliary.compression).toEqual(config.auxiliary.compression);
  });

  it("blocks deleting non-custom or current custom providers", () => {
    expect(() => buildCustomProviderDeleteUpdate({ providers: { deepseek: {} } }, "deepseek"))
      .toThrow(/自定义服务商/);
    expect(() => buildCustomProviderDeleteUpdate(
      {
        model: { provider: "custom:local" },
        providers: { "custom:local": {} },
      },
      "custom:local",
    )).toThrow(/当前主模型/);
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

  it("masks local provider api_key previews with first and last four characters", () => {
    expect(maskSecretPreview("sk-1234567890abcd")).toBe("sk-1...abcd");
    expect(maskSecretPreview("short-key")).toBe("***");
  });

  it("prefers env redacted_value over config api_key for credential previews", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "deepseek");
    expect(preset).toBeTruthy();

    const preview = getProviderCredentialPreview(
      {
        providers: {
          deepseek: {
            api_key: "config-secret-should-not-win",
          },
        },
      },
      {
        DEEPSEEK_API_KEY: {
          is_set: true,
          redacted_value: "env-...tail",
        },
      },
      preset!,
    );

    expect(preview).toBe("env-...tail");
  });

  it("falls back to locally masked config api_key when no env preview is available", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "deepseek");
    expect(preset).toBeTruthy();

    const preview = getProviderCredentialPreview(
      {
        providers: {
          deepseek: {
            api_key: "abcd-1234567890",
          },
        },
      },
      undefined,
      preset!,
    );

    expect(preview).toBe("abcd...7890");
  });

  it("treats env-only provider keys as saved credentials", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "deepseek");
    expect(preset).toBeTruthy();

    expect(providerHasSavedCredentials(
      {},
      "deepseek",
      {
        DEEPSEEK_API_KEY: {
          is_set: true,
          redacted_value: "deep...tail",
        },
      },
      preset!,
    )).toBe(true);
  });

  it("treats local custom providers as configured even when API key is empty", () => {
    const provider: ProviderPreset = {
      id: "custom:lm-studio",
      name: "LM Studio",
      vendor: "本地部署",
      region: "cn",
      baseUrl: "http://127.0.0.1:1234/v1",
      apiMode: "chat_completions",
      transport: "openai_chat",
      apiKeyLabel: "API Key",
      defaultModel: "local-model",
      models: [{ id: "local-model" }],
      isCustom: true,
    };

    expect(providerHasSavedCredentials(
      {
        providers: {
          "custom:lm-studio": {
            base_url: "http://127.0.0.1:1234/v1",
            model: "local-model",
          },
        },
      },
      "custom:lm-studio",
      undefined,
      provider,
    )).toBe(true);
  });

  it("uses XIAOMI_API_KEY as the canonical Xiaomi key while keeping MIMO_API_KEY as a legacy alias", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "xiaomi");
    expect(preset).toBeTruthy();

    expect(preset!.apiKeyLabel).toBe("XIAOMI_API_KEY");
    expect(providerApiKeyLabels(preset!)).toEqual(["XIAOMI_API_KEY", "MIMO_API_KEY"]);
  });

  it("treats legacy Xiaomi MIMO_API_KEY as saved credentials", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "xiaomi");
    expect(preset).toBeTruthy();

    const envVars = {
      MIMO_API_KEY: {
        is_set: true,
        redacted_value: "mimo...tail",
      },
    };

    expect(providerHasSavedCredentials({}, "xiaomi", envVars, preset!)).toBe(true);
    expect(getProviderCredentialPreview({}, envVars, preset!)).toBe("mimo...tail");
  });

  it("prefers canonical Xiaomi XIAOMI_API_KEY over the legacy MIMO_API_KEY alias", () => {
    const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "xiaomi");
    expect(preset).toBeTruthy();

    const preview = getProviderCredentialPreview(
      {},
      {
        XIAOMI_API_KEY: {
          is_set: true,
          redacted_value: "xiao...tail",
        },
        MIMO_API_KEY: {
          is_set: true,
          redacted_value: "mimo...tail",
        },
      },
      preset!,
    );

    expect(preview).toBe("xiao...tail");
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
          apiKeyAliases: ["REMOTE_LEGACY_KEY", "REMOTE_LEGACY_KEY", ""],
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
          apiKeyAliases: ["REMOTE_LEGACY_KEY"],
          defaultModel: "remote-model",
        },
      ],
    });
  });

  it("keeps promotion fields from the remote catalog and drops malformed ones", async () => {
    mockedFetchExternalJSON.mockResolvedValue({
      version: "remote-v2",
      providers: [
        {
          id: "packycode",
          name: "PackyCode",
          baseUrl: "https://www.packyapi.com",
          defaultModel: "claude-opus-4-8",
          websiteUrl: "https://www.packyapi.com",
          icon: " packycode ",
          promotion: {
            url: "https://www.packyapi.com/register?aff=our-code",
            badge: "partner",
          },
        },
        {
          id: "bad-promo",
          name: "Bad Promo",
          baseUrl: "https://bad.example/v1",
          defaultModel: "m",
          websiteUrl: "http://insecure.example",
          promotion: {
            url: "javascript:alert(1)",
            badge: "sponsor",
          },
        },
      ],
    });

    const catalog = await fetchRemoteProviderCatalog("https://cdn.example.com/catalog.json");
    const packy = catalog.providers.find((provider) => provider.id === "packycode");
    expect(packy).toMatchObject({
      icon: "packycode",
      websiteUrl: "https://www.packyapi.com",
      promotion: {
        url: "https://www.packyapi.com/register?aff=our-code",
        badge: "partner",
      },
    });

    const bad = catalog.providers.find((provider) => provider.id === "bad-promo");
    expect(bad?.promotion).toBeUndefined();
    expect(bad?.websiteUrl).toBeUndefined();
  });

  it("never lets a remote entry override wire settings of a built-in provider", () => {
    const builtin = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "deepseek")!;
    const merged = mergeProviderCatalog(BUILTIN_PROVIDER_CATALOG, {
      version: "remote-v3",
      providers: [
        {
          ...builtin,
          baseUrl: "https://evil.example/v1",
          apiMode: "anthropic_messages",
          transport: "anthropic_messages",
          apiKeyLabel: "EVIL_KEY",
          promotion: {
            url: "https://platform.deepseek.com/",
          },
        },
        {
          id: "new-remote-provider",
          name: "New Remote",
          vendor: "Remote",
          region: "cn",
          baseUrl: "https://api.new-remote.example/v1",
          apiMode: "chat_completions",
          transport: "openai_chat",
          apiKeyLabel: "NEW_REMOTE_API_KEY",
          defaultModel: "m1",
          models: [{ id: "m1" }],
        },
      ],
    });

    const deepseek = merged.providers.find((provider) => provider.id === "deepseek");
    expect(deepseek).toMatchObject({
      baseUrl: builtin.baseUrl,
      apiMode: builtin.apiMode,
      transport: builtin.transport,
      apiKeyLabel: builtin.apiKeyLabel,
      promotion: { url: "https://platform.deepseek.com/" },
    });

    // Brand-new remote providers keep their own wire settings.
    expect(merged.providers.find((provider) => provider.id === "new-remote-provider")).toMatchObject({
      baseUrl: "https://api.new-remote.example/v1",
    });
    expect(merged.version).toBe("remote-v3");
  });
});

describe("parseContextWindowInput", () => {
  it("treats empty / blank input as auto (0)", () => {
    expect(parseContextWindowInput("")).toBe(0);
    expect(parseContextWindowInput("   ")).toBe(0);
    expect(parseContextWindowInput(undefined)).toBe(0);
  });

  it("treats an explicit 0 as auto", () => {
    expect(parseContextWindowInput("0")).toBe(0);
  });

  it("parses a positive integer and trims whitespace", () => {
    expect(parseContextWindowInput("128000")).toBe(128000);
    expect(parseContextWindowInput("  200000 ")).toBe(200000);
  });

  it("floors decimals", () => {
    expect(parseContextWindowInput("100.9")).toBe(100);
  });

  it("rejects non-numeric and negative values as auto", () => {
    expect(parseContextWindowInput("128k")).toBe(0);
    expect(parseContextWindowInput("abc")).toBe(0);
    expect(parseContextWindowInput("-5")).toBe(0);
  });
});

describe("context window override in config updates", () => {
  const preset = BUILTIN_PROVIDER_CATALOG.providers.find((provider) => provider.id === "deepseek")!;

  it("writes a positive override as a top-level model_context_length field", () => {
    const config = buildCurrentModelConfigUpdate({}, preset, {
      apiKey: "",
      baseUrl: "",
      model: "deepseek-chat",
      contextWindow: "200000",
    });
    expect(config.model_context_length).toBe(200000);
    // The override lives at the top level, not nested in model.* — the backend
    // denormalizes it back into model.context_length.
    expect(config.model.context_length).toBeUndefined();
  });

  it("resets the override to 0 when the field is left empty (switch semantics)", () => {
    const config = buildCurrentModelConfigUpdate(
      { model_context_length: 200000 },
      preset,
      { apiKey: "", baseUrl: "", model: "deepseek-chat", contextWindow: "" },
    );
    expect(config.model_context_length).toBe(0);
  });

  it("does not write the override in the provider-only settings path", () => {
    const config = buildProviderSettingsUpdate(
      { model: { provider: "kimi-for-coding", default: "kimi-k2.6" } },
      preset,
      { apiKey: "", baseUrl: "", model: "deepseek-chat", contextWindow: "200000" },
    );
    expect(config.model_context_length).toBeUndefined();
    // The active model is untouched by a non-current provider save.
    expect(config.model).toEqual({ provider: "kimi-for-coding", default: "kimi-k2.6" });
  });
});

describe("api mode display helpers", () => {
  it("names each api mode for the UI", () => {
    expect(apiModeDisplayName("anthropic_messages")).toContain("Anthropic");
    expect(apiModeDisplayName("chat_completions")).toContain("OpenAI");
    expect(apiModeDisplayName("codex_responses")).toContain("Responses");
  });

  it("badges only the non-default protocols", () => {
    expect(apiModeBadgeLabel("anthropic_messages")).toBe("Claude");
    expect(apiModeBadgeLabel("codex_responses")).toBe("Codex");
    expect(apiModeBadgeLabel("chat_completions")).toBeNull();
  });
});

describe("chatEndpointPreviewUrl", () => {
  it("appends /v1/messages for anthropic bases (SDK mirror)", () => {
    expect(chatEndpointPreviewUrl("anthropic_messages", "https://www.packyapi.com")).toBe(
      "https://www.packyapi.com/v1/messages",
    );
    expect(chatEndpointPreviewUrl("anthropic_messages", "https://api.aicodemirror.com/api/claudecode/")).toBe(
      "https://api.aicodemirror.com/api/claudecode/v1/messages",
    );
  });

  it("does not double the /v1 segment for anthropic bases already ending in /v1", () => {
    expect(chatEndpointPreviewUrl("anthropic_messages", "https://relay.example/v1")).toBe(
      "https://relay.example/v1/messages",
    );
  });

  it("appends /chat/completions for openai-compatible bases", () => {
    expect(chatEndpointPreviewUrl("chat_completions", "https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/chat/completions",
    );
  });

  it("shows the native Gemini generateContent endpoint", () => {
    expect(chatEndpointPreviewUrl("chat_completions", "https://generativelanguage.googleapis.com/v1beta")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
    );
  });

  it("appends /responses for codex bases and returns empty for empty input", () => {
    expect(chatEndpointPreviewUrl("codex_responses", "https://api.openai.com/v1")).toBe(
      "https://api.openai.com/v1/responses",
    );
    expect(chatEndpointPreviewUrl("chat_completions", "   ")).toBe("");
  });
});

describe("detectCustomApiModeFromUrl", () => {
  it("pre-selects anthropic for /anthropic-suffixed urls (Core heuristic parity)", () => {
    expect(detectCustomApiModeFromUrl("https://api.minimaxi.com/anthropic")).toBe("anthropic_messages");
    expect(detectCustomApiModeFromUrl("https://relay.example/anthropic/v1")).toBe("anthropic_messages");
  });

  it("defaults to chat_completions for other or partial urls", () => {
    expect(detectCustomApiModeFromUrl("https://api.deepseek.com/v1")).toBe("chat_completions");
    expect(detectCustomApiModeFromUrl("not a url")).toBe("chat_completions");
    expect(detectCustomApiModeFromUrl("")).toBe("chat_completions");
  });
});
