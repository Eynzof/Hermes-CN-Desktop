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
