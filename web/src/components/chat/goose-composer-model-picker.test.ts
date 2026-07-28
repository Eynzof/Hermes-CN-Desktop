import { describe, expect, it } from "vitest";
import type { ModelOptionsResult } from "@hermes/protocol";
import { buildCandidates } from "./goose-composer-model-picker";

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

  it("omits providers that Core explicitly marks as unconfigured", () => {
    const options = {
      providers: [
        {
          slug: "minimax-cn",
          name: "MiniMax",
          models: ["MiniMax-M3", "MiniMax-M2.7"],
          authenticated: false,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    expect(buckets.all).toHaveLength(0);
    expect(buckets.configured).toHaveLength(0);
  });

  it("treats a provider with advertised models as available on older Core responses", () => {
    const options = {
      providers: [
        {
          slug: "deepseek",
          name: "DeepSeek",
          models: ["deepseek-chat"],
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    expect(buckets.configured.map((candidate) => candidate.key)).toContain("deepseek:deepseek-chat");
  });

  it("uses Core models.dev metadata before the desktop catalog for capability tags", () => {
    const options = {
      providers: [
        {
          slug: "deepseek",
          name: "DeepSeek",
          models: ["deepseek-v4-flash"],
          authenticated: true,
          capabilities: {
            "deepseek-v4-flash": {
              supports_tools: false,
              supports_vision: true,
              supports_pdf: true,
              supports_audio: true,
              supports_video: true,
              supports_reasoning: true,
              supports_reasoning_control: true,
              open_weights: true,
              context_window: 1_000_000,
              max_output_tokens: 65_536,
              model_family: "deepseek",
            },
          },
        },
      ],
    } as ModelOptionsResult;

    const candidate = buildCandidates(options, []).configured[0];

    expect(candidate.caps).toMatchObject({
      id: "deepseek-v4-flash",
      contextWindow: 1_000_000,
      supportsVision: true,
      supportsPdf: true,
      supportsAudio: true,
      supportsVideo: true,
      supportsTools: false,
      supportsReasoning: true,
      supportsReasoningControl: true,
      openWeights: true,
    });
  });

  it("reuses the canonical DeepSeek icon for custom:deepseek rows", () => {
    const options = {
      providers: [
        {
          slug: "deepseek",
          name: "DeepSeek",
          models: ["deepseek-chat"],
          authenticated: true,
        },
        {
          slug: "custom:deepseek",
          name: "DeepSeek",
          models: ["deepseek-v4-pro"],
          authenticated: true,
          is_user_defined: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);
    const canonical = buckets.all.find((candidate) => candidate.providerSlug === "deepseek");
    const custom = buckets.all.find((candidate) => candidate.providerSlug === "custom:deepseek");

    expect(custom).toMatchObject({ catalogId: "deepseek" });
    expect(custom?.iconUrl).toBeTruthy();
    expect(custom?.iconUrl).toBe(canonical?.iconUrl);
  });

  it("limits each configured provider to five catalog-curated models", () => {
    const options = {
      provider: "minimax-cn",
      model: "MiniMax-M3",
      providers: [
        {
          slug: "minimax-cn",
          name: "MiniMax",
          models: [
            "MiniMax-M3",
            "MiniMax-M2.7",
            "MiniMax-M2.7-highspeed",
            "MiniMax-M2.5",
            "MiniMax-M2.5-highspeed",
            "MiniMax-M2.1",
          ],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);
    const minimaxModels = buckets.configured
      .filter((candidate) => candidate.providerSlug === "minimax-cn")
      .map((candidate) => candidate.model);

    expect(minimaxModels).toEqual([
      "MiniMax-M3",
      "MiniMax-M2.7",
      "MiniMax-M2.7-highspeed",
      "MiniMax-M2.5",
      "MiniMax-M2.5-highspeed",
    ]);
  });

  it("keeps the current custom model inside the five-model shortlist", () => {
    const options = {
      provider: "my-provider",
      model: "custom-current",
      providers: [
        {
          slug: "my-provider",
          name: "My Provider",
          models: ["m1", "m2", "m3", "m4", "m5", "custom-current"],
          authenticated: true,
          is_user_defined: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    expect(buckets.configured.map((candidate) => candidate.model)).toEqual([
      "m1",
      "m2",
      "m3",
      "m4",
      "custom-current",
    ]);
  });

  it("does not add a duplicate static provider when Core returns an aliased provider slug", () => {
    const options = {
      providers: [
        {
          slug: "kimi-coding",
          name: "Kimi Coding Plan",
          models: ["kimi-k3"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;

    const buckets = buildCandidates(options, []);

    expect(buckets.all.some((candidate) => candidate.providerSlug === "kimi-for-coding")).toBe(false);
    expect(buckets.all.some((candidate) => candidate.providerSlug === "kimi-coding")).toBe(true);
  });

  it("keeps recently used models in the complete available-model bucket", () => {
    const options = {
      providers: [
        {
          slug: "deepseek",
          name: "DeepSeek",
          models: ["deepseek-chat"],
          authenticated: true,
        },
      ],
    } as ModelOptionsResult;
    const usage = [
      {
        key: "deepseek:deepseek-chat",
        provider: "deepseek",
        model: "deepseek-chat",
        count: 2,
        lastUsedAt: Date.now(),
      },
    ];

    const buckets = buildCandidates(options, usage);

    expect(buckets.recent.map((candidate) => candidate.key)).toContain("deepseek:deepseek-chat");
    expect(buckets.configured.map((candidate) => candidate.key)).toContain("deepseek:deepseek-chat");
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
