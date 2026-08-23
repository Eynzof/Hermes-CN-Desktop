import { describe, expect, it } from "vitest";
import { buildInsightsLines, formatInsightsMarkdown } from "./insights";
import type { AnalyticsResponse } from "@hermes/protocol";

function analytics(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    daily: [],
    by_model: [],
    top_sessions: [],
    totals: {
      total_tokens: 0,
      total_sessions: 0,
      total_api_calls: 0,
    } as never,
    comparison: { previous_totals: { total_tokens: 0 } as never },
    period_days: 30,
    skills: {
      summary: {
        total_skill_loads: 0,
        total_skill_edits: 0,
        total_skill_actions: 0,
        distinct_skills_used: 0,
      },
      top_skills: [],
    },
    ...overrides,
  };
}

describe("buildInsightsLines — header", () => {
  it("renders the header with the default 30-day window", () => {
    const lines = buildInsightsLines({});
    expect(lines[0]).toBe("📊 Usage Insights — last 30 days");
    expect(lines).toContain("No analytics or turn stats available.");
  });

  it("honours days and source", () => {
    const lines = buildInsightsLines({ days: 7, source: "local" });
    expect(lines[0]).toBe("📊 Usage Insights — last 7 days · source local");
  });
});

describe("buildInsightsLines — analytics path", () => {
  it("summarises totals with thousands separators", () => {
    const lines = buildInsightsLines({
      analytics: analytics({
        totals: {
          total_tokens: 1_234_567,
          total_sessions: 42,
          total_api_calls: 2100,
        } as never,
      }),
    });
    expect(lines).toContain("总 Tokens: 1,234,567");
    expect(lines).toContain("会话数: 42");
    expect(lines).toContain("API 调用: 2,100");
  });

  it("lists top models sorted by token usage descending with provider label", () => {
    const lines = buildInsightsLines({
      analytics: analytics({
        by_model: [
          { provider: "openrouter", model: "claude", input_tokens: 100, output_tokens: 50 } as never,
          { provider: "nous", model: "hermes", input_tokens: 1000, output_tokens: 500 } as never,
          { provider: "", model: "bare", input_tokens: 10, output_tokens: 5 } as never,
        ],
      }),
    });
    const indexOfTop = lines.indexOf("Top Models:");
    const hermes = lines.findIndex((l) => l.includes("nous · hermes"));
    const claude = lines.findIndex((l) => l.includes("openrouter · claude"));
    const bare = lines.findIndex((l) => l.includes("bare"));
    expect(indexOfTop).toBeGreaterThan(-1);
    expect(hermes).toBeGreaterThan(indexOfTop);
    expect(claude).toBeGreaterThan(hermes);
    expect(bare).toBeGreaterThan(claude);
    expect(lines[hermes]).toContain("1,500 tokens");
    expect(lines[claude]).toContain("150 tokens");
  });

  it("caps the model list at five entries", () => {
    const by_model = Array.from({ length: 8 }, (_, i) => ({
      provider: "p",
      model: `m${i}`,
      input_tokens: i,
      output_tokens: 0,
    })) as never;
    const lines = buildInsightsLines({ analytics: analytics({ by_model }) });
    const topIndex = lines.indexOf("Top Models:");
    const modelLines = lines.slice(topIndex + 1).filter((l) => l.includes(" tokens"));
    expect(modelLines).toHaveLength(5);
  });

  it("omits the Top Models block when there are no models", () => {
    const lines = buildInsightsLines({ analytics: analytics({ by_model: [] }) });
    expect(lines).not.toContain("Top Models:");
  });

  it("renders the skills summary when skills were used", () => {
    const lines = buildInsightsLines({
      analytics: analytics({
        skills: {
          summary: {
            total_skill_loads: 33,
            total_skill_edits: 0,
            total_skill_actions: 0,
            distinct_skills_used: 7,
          },
          top_skills: [],
        } as never,
      }),
    });
    expect(lines).toContain("Skills:");
    expect(lines.some((l) => l.includes("使用过的 skills: 7"))).toBe(true);
    expect(lines.some((l) => l.includes("skill 调用: 33"))).toBe(true);
  });

  it("omits the skills block when nothing was used", () => {
    const lines = buildInsightsLines({ analytics: analytics() });
    expect(lines).not.toContain("Skills:");
  });

  it("renders top sessions sorted by total tokens, falling back to session_id for the title", () => {
    const lines = buildInsightsLines({
      analytics: analytics({
        top_sessions: [
          { session_id: "s-low", title: "Low", input_tokens: 10, output_tokens: 0 } as never,
          { session_id: "s-high", title: "High", input_tokens: 500, output_tokens: 500 } as never,
          { session_id: "s-null-title", title: null, input_tokens: 50, output_tokens: 0 } as never,
        ],
      }),
    });
    const high = lines.findIndex((l) => l.includes("High"));
    const nullTitle = lines.findIndex((l) => l.includes("s-null-title"));
    const low = lines.findIndex((l) => l.includes("Low"));
    expect(high).toBeGreaterThan(-1);
    expect(nullTitle).toBeGreaterThan(high);
    expect(low).toBeGreaterThan(nullTitle);
    expect(lines[high]).toContain("1,000 tokens");
  });

  it("prefers analytics over turnStats when both are present", () => {
    const lines = buildInsightsLines({
      analytics: analytics({ by_model: [{ provider: "p", model: "m", input_tokens: 1, output_tokens: 1 } as never] }),
      turnStats: [{ id: "t1", sessionId: "s1", tokensInput: 999, tokensOutput: 999 }] as never,
    });
    expect(lines.some((l) => l.includes("本地回合统计"))).toBe(false);
    expect(lines.some((l) => l.includes("总 Tokens:"))).toBe(true);
  });

  it("treats non-finite token numbers as zero", () => {
    const lines = buildInsightsLines({
      analytics: analytics({
        totals: { total_tokens: Number.POSITIVE_INFINITY, total_sessions: Number.NaN, total_api_calls: 1 } as never,
        by_model: [{ provider: "p", model: "m", input_tokens: Number.NaN, output_tokens: Infinity } as never],
      }),
    });
    expect(lines).toContain("总 Tokens: 0");
    expect(lines).toContain("会话数: 0");
    expect(lines).toContain("API 调用: 1");
    expect(lines.find((l) => l.includes("p · m"))).toContain("0 tokens");
  });
});

describe("buildInsightsLines — turnStats path", () => {
  const turnStats = [
    { id: "t1", sessionId: "s1", model: "claude", tokensInput: 100, tokensOutput: 50 },
    { id: "t2", sessionId: "s1", model: "hermes", tokensInput: 200, tokensOutput: 100 },
    { id: "t3", sessionId: "s2", model: " ", tokensInput: 10, tokensOutput: 0 },
  ];

  it("totals tokens and renders the local turn count", () => {
    const lines = buildInsightsLines({ turnStats: turnStats as never });
    expect(lines).toContain("总 Tokens: 460 (in 310 / out 150)");
    expect(lines).toContain("本地回合统计: 3");
  });

  it("ranks models by tokens and groups unknown/blank models", () => {
    const lines = buildInsightsLines({ turnStats: turnStats as never });
    const topIndex = lines.indexOf("Top Models:");
    const hermes = lines.findIndex((l) => l.includes("hermes"));
    const claude = lines.findIndex((l) => l.includes("claude"));
    const unknown = lines.findIndex((l) => l.includes("unknown"));
    expect(topIndex).toBeGreaterThan(-1);
    expect(hermes).toBeGreaterThan(topIndex);
    expect(claude).toBeGreaterThan(hermes);
    expect(unknown).toBeGreaterThan(claude);
    expect(lines[unknown]).toContain("10 tokens");
  });

  it("does not render the fallback message when turnStats are present", () => {
    const lines = buildInsightsLines({ turnStats: turnStats as never });
    expect(lines).not.toContain("No analytics or turn stats available.");
  });

  it("falls through to the empty message for an empty stats array", () => {
    const lines = buildInsightsLines({ turnStats: [] });
    expect(lines).toContain("No analytics or turn stats available.");
  });
});

describe("formatInsightsMarkdown", () => {
  it("joins the insight lines into one markdown string", () => {
    const markdown = formatInsightsMarkdown({ days: 3 });
    expect(markdown).toBe(buildInsightsLines({ days: 3 }).join("\n"));
    expect(markdown).toContain("📊 Usage Insights — last 3 days");
  });
});
