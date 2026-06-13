import { describe, expect, it } from "vitest";
import {
  buildComposerContextUsage,
  contextUsagePercent,
  contextUsageRisk,
  estimateRenderedContextTokens,
} from "./context-usage";

describe("context usage helpers", () => {
  it("uses explicit percentage when present", () => {
    expect(contextUsagePercent({ used: 50, max: 100, percent: 12 })).toBe(12);
  });

  it("computes percentage from used and max", () => {
    expect(contextUsagePercent({ used: 500_000, max: 1_000_000 })).toBe(50);
  });

  it("caps the percentage at 100 even when the window is exceeded", () => {
    expect(contextUsagePercent({ used: 1_600_000, max: 1_000_000 })).toBe(100);
    expect(contextUsagePercent({ percent: 160 })).toBe(100);
    // ...but it still reads as danger.
    expect(contextUsageRisk({ used: 1_600_000, max: 1_000_000 })).toBe("danger");
  });

  it("classifies warning and danger levels", () => {
    expect(contextUsageRisk({ percent: 84 })).toBe("ok");
    expect(contextUsageRisk({ percent: 85 })).toBe("warning");
    expect(contextUsageRisk({ percent: 100 })).toBe("danger");
  });

  it("estimates rendered chat content instead of accumulated billing totals", () => {
    const estimated = estimateRenderedContextTokens([
      { text: "a".repeat(80_000) },
      { text: "b".repeat(40_000), tools: [{ name: "read", summary: "c".repeat(4_000) }] },
    ]);

    const usage = buildComposerContextUsage({
      live: { context_used: 0, context_max: 1_000_000, context_percent: 0 },
      modelInfo: { model: "qwen3.6-plus", effective_context_length: 1_000_000 },
      session: {
        model: "qwen3.6-plus",
        input_tokens: 900_000,
        output_tokens: 120_000,
      },
      estimatedUsed: estimated,
    });

    expect(usage?.used).toBe(estimated);
    expect(usage?.used).toBeGreaterThan(30_000);
    expect(usage?.used).toBeLessThan(40_000);
    expect(usage?.estimated).toBe(true);
    expect(usage?.used).not.toBe(1_020_000);
  });

  it("prefers live context usage over estimates", () => {
    const usage = buildComposerContextUsage({
      live: {
        model: "deepseek-v4-flash",
        context_used: 42_000,
        context_max: 128_000,
        context_percent: 33,
        compressions: 2,
      },
      estimatedUsed: 30_000,
    });

    expect(usage).toMatchObject({
      used: 42_000,
      max: 128_000,
      percent: 33,
      model: "deepseek-v4-flash",
      compressions: 2,
      estimated: false,
    });
  });
});
