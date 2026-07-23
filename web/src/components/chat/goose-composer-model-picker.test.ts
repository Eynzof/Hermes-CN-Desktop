import { describe, expect, it } from "vitest";
import type { ModelOptionsResult } from "@hermes/protocol";
import { BRAND } from "@/lib/brand.generated";
import { buildCandidates, groupCandidates } from "./goose-composer-model-picker";

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
  it("groups brand, Team, and user models by source and keeps brand JSON order", () => {
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

    const groups = groupCandidates(options);

    expect(groups.enterprise.map((candidate) => candidate.key)).toEqual([
      `custom:team-company-model:${firstBrandModel}`,
    ]);
    expect(groups.custom.map((candidate) => candidate.key)).toEqual([
      "custom:my-endpoint:local-model",
    ]);
    expect(groups.builtin.map((candidate) => candidate.key)).toEqual([
      `${brandProvider}:${firstBrandModel}`,
      `${brandProvider}:${secondBrandModel}`,
      "official-provider:official-only",
    ]);
  });

  it("treats the brand messages provider as built-in and hides unconfigured rows", () => {
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
      ],
    } as ModelOptionsResult;

    const groups = groupCandidates(options);

    expect(groups.builtin.map((candidate) => candidate.key)).toEqual([
      `${messagesProvider}:${brandModel}`,
    ]);
    expect(groups.enterprise).toEqual([]);
    expect(groups.custom).toEqual([]);
  });
});
