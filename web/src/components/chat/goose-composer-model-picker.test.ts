import { describe, expect, it } from "vitest";
import type { ModelOptionsResult } from "@hermes/protocol";
import { BRAND } from "@/lib/brand.generated";
import {
  buildCandidates,
  groupCandidates,
  isTeamServiceProviderUrl,
  modelButtonText,
} from "./goose-composer-model-picker";

describe("modelButtonText", () => {
  it("shows the friendly Team model name instead of its opaque model id", () => {
    const options = {
      provider: "custom:gpt软件研发",
      model: "mdl_rVPYUJij75Ht-cvb",
      providers: [{
        slug: "custom:gpt软件研发",
        name: "gpt软件研发",
        models: ["mdl_rVPYUJij75Ht-cvb"],
        authenticated: true,
        api_url: `${BRAND.teamServiceUrl}/api/workbuddy/proxy/v1`,
      }],
    } as ModelOptionsResult;

    expect(modelButtonText(undefined, options)).toBe("gpt软件研发");
  });

  it("keeps regular model ids visible", () => {
    const options = {
      provider: "deepseek",
      model: "deepseek-chat",
      providers: [{ slug: "deepseek", name: "DeepSeek", models: ["deepseek-chat"] }],
    } as ModelOptionsResult;

    expect(modelButtonText(undefined, options)).toBe("deepseek-chat");
  });

  it("uses config classification when a Team model has a custom proxy URL", () => {
    const options = {
      provider: "custom:研发模型",
      model: "mdl_opaque_id",
      providers: [{ slug: "custom:研发模型", name: "研发模型", models: ["mdl_opaque_id"] }],
    } as ModelOptionsResult;

    expect(modelButtonText(undefined, options, {
      enterpriseProviderIds: new Set(["custom:研发模型"]),
    })).toBe("研发模型");
  });
});

describe("buildCandidates", () => {
  it("augments a stale MiniMax gateway model list with MiniMax-M3 from the desktop catalog", () => {
    const options = {
      provider: "minimax-cn",
      model: "MiniMax-M2.7",
      providers: [
        {
          slug: "minimax-cn",
          name: "MiniMax",
          models: ["MiniMax-M2.7"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);
    const m3 = buckets.all.find((candidate) =>
      candidate.providerSlug === "minimax-cn" && candidate.model === "MiniMax-M3");

    expect(m3).toMatchObject({
      configured: true,
      model: "MiniMax-M3",
      providerSlug: "minimax-cn",
    });
    expect(m3?.caps).toMatchObject({
      contextWindow: 1_000_000,
      supportsTools: true,
      supportsReasoning: true,
    });
  });

  it("keeps MiniMax-M3 visible when the gateway only returns an unconfigured provider placeholder", () => {
    const options = {
      providers: [
        {
          slug: "minimax-cn",
          name: "MiniMax",
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    expect(buckets.recommended.map((candidate) => candidate.key)).toContain("minimax-cn:MiniMax-M3");
    expect(buckets.all.map((candidate) => candidate.key)).toContain("minimax-cn:MiniMax-M2.7");
  });

  it("splits the virtual moa provider into its own bucket instead of the regular groups", () => {
    const options = {
      providers: [
        {
          slug: "minimax-cn",
          name: "MiniMax",
          models: ["MiniMax-M3"],
          authenticated: true,
        },
        {
          slug: "moa",
          name: "Mixture of Agents",
          models: ["default", "review"],
          authenticated: true,
          source: "virtual",
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    // MoA 预设进独立分组，key 形如 moa:<preset>，点击即 "<preset> --provider moa"。
    expect(buckets.moa.map((candidate) => candidate.key)).toEqual(["moa:default", "moa:review"]);
    expect(buckets.moa[0]).toMatchObject({
      providerSlug: "moa",
      providerName: "Mixture of Agents",
      model: "default",
      configured: true,
    });
    // 不允许再混入常规分桶造成重复卡片。
    const regularKeys = [
      ...buckets.all,
      ...buckets.recent,
      ...buckets.configured,
      ...buckets.recommended,
      ...buckets.more,
    ].map((candidate) => candidate.key);
    expect(regularKeys.filter((key) => key.startsWith("moa:"))).toHaveLength(0);
  });

  it("keeps the moa bucket out of recent even when usage log has a moa entry", () => {
    const options = {
      providers: [
        {
          slug: "moa",
          name: "Mixture of Agents",
          models: ["default"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, [
      { key: "moa:default", provider: "moa", model: "default", count: 3, lastUsedAt: Date.now() },
    ]);

    expect(buckets.recent).toHaveLength(0);
    expect(buckets.moa.map((candidate) => candidate.key)).toEqual(["moa:default"]);
  });
});

describe("groupCandidates", () => {
  it("groups brand defaults as built-in and Team models as enterprise", () => {
    const [firstBrandModel, secondBrandModel] = BRAND.accountDefaultModels;
    const brandProvider = `custom:${BRAND.providerKey}`;
    const options = {
      providers: [
        {
          slug: brandProvider,
          name: BRAND.appName,
          models: [secondBrandModel, "not-in-brand-json", firstBrandModel],
          authenticated: true,
        },
        {
          slug: "custom:team-company-model",
          name: "企业模型",
          models: [firstBrandModel],
          authenticated: true,
        },
        {
          slug: "custom:my-endpoint",
          name: "我的模型",
          models: ["local-model"],
          authenticated: true,
        },
        {
          slug: "official-provider",
          name: "Official",
          models: [firstBrandModel, "official-only"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options, {
      showEnterprise: true,
      savedCustomProviderIds: new Set(["custom:my-endpoint"]),
    });

    expect(groups.enterprise.map((candidate) => candidate.key)).toEqual([
      `custom:team-company-model:${firstBrandModel}`,
    ]);
    expect(groups.custom.map((candidate) => candidate.key)).toEqual([
      "custom:my-endpoint:local-model",
    ]);
    expect(groups.builtin.map((candidate) => candidate.key)).toEqual([
      ...BRAND.accountDefaultModels.map((model) => `${brandProvider}:${model}`),
      "official-provider:official-only",
    ]);
  });

  it("fills the complete built-in brand catalog when Core advertises only two models", () => {
    const brandProvider = `custom:${BRAND.providerKey}`;
    const options = {
      providers: [{
        slug: brandProvider,
        name: BRAND.appName,
        models: BRAND.accountDefaultModels.slice(0, 2),
        authenticated: true,
      }],
    } as ModelOptionsResult;

    const groups = groupCandidates(options);

    expect(groups.builtin.map((candidate) => candidate.model)).toEqual(
      [...BRAND.accountDefaultModels],
    );
  });

  it("keeps brand defaults but hides Team models while logged out", () => {
    const brandModel = BRAND.accountDefaultModels[0];
    const messagesProvider = `custom:${BRAND.providerKey}-messages`;
    const options = {
      providers: [
        {
          slug: messagesProvider,
          name: `${BRAND.appName} Messages`,
          models: [brandModel],
          authenticated: true,
        },
        {
          slug: "custom:not-ready",
          name: "Not ready",
          models: ["not-ready"],
          authenticated: false,
        },
        {
          slug: "custom:team-company-model",
          name: "Enterprise",
          models: [brandModel],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options, { showEnterprise: false });

    expect(groups.builtin.map((candidate) => candidate.key)).toEqual(
      BRAND.accountDefaultModels.map((model) => `${messagesProvider}:${model}`),
    );
    expect(groups.enterprise).toEqual([]);
    expect(groups.custom).toEqual([]);
  });

  it("shows one row per branded model when chat and Messages providers overlap", () => {
    const [flash, pro, sol, kimi, glm, claude] = BRAND.accountDefaultModels;
    const regularProvider = `custom:${BRAND.providerKey}`;
    const messagesProvider = `custom:${BRAND.providerKey}-messages`;
    const options = {
      providers: [
        {
          slug: regularProvider,
          name: BRAND.appName,
          models: [flash, pro, sol],
          authenticated: true,
        },
        {
          slug: messagesProvider,
          name: `${BRAND.appName} Messages`,
          models: [flash, pro, sol, kimi, glm, claude],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options);

    expect(groups.builtin.map((candidate) => candidate.key)).toEqual([
      `${regularProvider}:${flash}`,
      `${regularProvider}:${pro}`,
      `${regularProvider}:${sol}`,
      `${messagesProvider}:${kimi}`,
      `${messagesProvider}:${glm}`,
      `${messagesProvider}:${claude}`,
    ]);
  });

  it("only shows custom providers that exist in the saved custom-model set", () => {
    const options = {
      providers: [
        {
          slug: "custom:old-account-provider",
          name: "Managed account",
          models: ["managed-model"],
          authenticated: true,
        },
        {
          slug: "custom:my-endpoint",
          name: "My endpoint",
          models: ["my-model"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options, {
      savedCustomProviderIds: new Set(["custom:my-endpoint"]),
    });

    expect(groups.custom.map((candidate) => candidate.key)).toEqual([
      "custom:my-endpoint:my-model",
    ]);
  });

  it("groups a Team-managed friendly-name gateway slug as enterprise", () => {
    const options = {
      providers: [
        {
          slug: "custom:rightcodegpt",
          name: "rightcodegpt",
          models: ["mdl_opaque_id"],
          authenticated: true,
          source: "user-config",
        },
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options, {
      showEnterprise: true,
      enterpriseProviderIds: new Set([
        "custom:team-mdl_opaque_id",
        "custom:rightcodegpt",
      ]),
      savedCustomProviderIds: new Set(),
    });

    expect(groups.enterprise.map((candidate) => candidate.key)).toEqual([
      "custom:rightcodegpt:mdl_opaque_id",
    ]);
    expect(groups.custom).toEqual([]);
  });

  it("groups a provider served by the brand Team service as enterprise", () => {
    const apiUrl = `${BRAND.teamServiceUrl}/api/workbuddy/proxy/v1`;
    const options = {
      providers: [
        {
          slug: "custom:rightcodegpt",
          name: "rightcodegpt",
          models: ["mdl_opaque_id"],
          authenticated: true,
          source: "user-config",
          api_url: apiUrl,
        },
      ],
    } as ModelOptionsResult;

    expect(isTeamServiceProviderUrl(apiUrl)).toBe(true);

    const groups = groupCandidates(options, {
      showEnterprise: true,
      savedCustomProviderIds: new Set(),
    });

    expect(groups.enterprise).toMatchObject([
      {
        key: "custom:rightcodegpt:mdl_opaque_id",
        displayName: "rightcodegpt",
        subtitle: "由企业管理员下发",
      },
    ]);
    expect(groups.custom).toEqual([]);
  });
});
