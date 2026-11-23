import { describe, expect, it } from "vitest";
import type { ModelOptionsResult } from "@hermes/protocol";
import { buildCandidates, groupPickerRows } from "./goose-composer-model-picker";

describe("buildCandidates", () => {
  it("uses the advertised catalog and order even when an older desktop catalog is available", () => {
    const result = buildCandidates({ providers: [{ slug: "xiaomi", models: ["mimo-new", "mimo-next"] }] }, []);
    expect(result.all.map(c => c.model)).toEqual(["mimo-new", "mimo-next"]);
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

  it("limits the preview while preserving every advertised model for search and expansion", () => {
    const models = Array.from({ length: 19 }, (_, i) => `model-${i + 1}`);
    const options = { providers: [{ slug: "example", models }] };
    const { configured } = buildCandidates(options, []);
    expect(configured.map(c => c.model)).toEqual(models);
    expect(groupPickerRows(configured, new Set(), false)[0].rows).toHaveLength(5);
    expect(groupPickerRows(configured, new Set(["example"]), false)[0].rows).toHaveLength(19);
    expect(groupPickerRows(configured, new Set(), true)[0].rows.at(-1)?.model).toBe("model-19");
  });

  it("pins the current model ahead of advertised recent choices without restoring retired ones", () => {
    const options = { provider: "example", model: "current", providers: [{ slug: "example", models: ["a", "b", "c"] }] };
    const usage = ["retired", "c"].map(model => ({ key: `example:${model}`, provider: "example", model, count: 1, lastUsedAt: Date.now() }));
    const result = buildCandidates(options, usage);
    expect(result.configured.map(c => c.model)).toEqual(["current", "c", "a", "b"]);
    expect(result.configured[0].unlistedCurrent).toBe(true);
    expect(result.recent.map(c => c.model)).toEqual(["c"]);
  });

  it("retains the active route and marks a built-in fallback when options are unavailable", () => {
    for (const response of [null, { provider: "xiaomi", model: "active", providers: [{ slug: "xiaomi", authenticated: true, models: [] }] }]) {
      const result = buildCandidates(response, [], { provider: "xiaomi", model: "active" });
      expect(result.configured[0].model).toBe("active");
      expect(result.configured.length).toBeGreaterThan(1);
      expect(result.unavailable.map(p => p.slug)).toEqual(["xiaomi"]);
    }
  });

  it("preserves separately addressable routes with the same display name and model", () => {
    const providers = ["a", "b"].map((id, i) => ({ slug: `custom:twin-${id}`, name: "Twin", api_url: `http://127.0.0.1:${19318 + i}/v1`, models: ["shared"] }));
    const { configured } = buildCandidates({ providers }, []);
    expect(configured.map(c => [c.providerSlug, c.baseUrl])).toEqual(providers.map(p => [p.slug, p.api_url]));
    expect(groupPickerRows(configured, new Set(), false)).toHaveLength(2);
  });

  it("keeps ambiguous backend rows visible but unavailable for selection", () => {
    const providers = ["http://127.0.0.1:9911/v1", "http://127.0.0.1:9912/v1"].map(api_url => ({
      slug: "custom:twin", name: "Twin", api_url, models: ["shared"],
    }));
    const result = buildCandidates({ provider: "custom:twin", model: "shared", providers }, []);
    expect(result.conflicting.has("custom:twin")).toBe(true);
    expect(result.configured.map(c => c.baseUrl)).toEqual(providers.map(p => p.api_url));
    expect(result.configured.every(c => c.routeConflict && !c.active)).toBe(true);
    expect(groupPickerRows(result.configured, new Set(), false)).toHaveLength(2);
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
