import { describe, expect, it } from "vitest";
import type { AnalyticsResponse } from "@hermes/protocol";
import { analyticsContractErrorMessage, buildAnalyticsViewModel } from "./analytics";

function totals(overrides: Partial<AnalyticsResponse["totals"]> = {}): AnalyticsResponse["totals"] {
  return {
    total_input: 0,
    total_output: 0,
    total_tokens: 0,
    total_cache_read: 0,
    total_cache_write: 0,
    total_reasoning: 0,
    total_sessions: 0,
    total_api_calls: 0,
    avg_tokens_per_session: 0,
    ...overrides,
  };
}

function response(overrides: Partial<AnalyticsResponse> = {}): AnalyticsResponse {
  return {
    daily: [],
    by_model: [],
    top_sessions: [],
    totals: totals(),
    comparison: { previous_totals: totals() },
    period_days: 7,
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

describe("buildAnalyticsViewModel", () => {
  it("fills daily points and computes KPI deltas", () => {
    const vm = buildAnalyticsViewModel(
      response({
        daily: [
          {
            day: "2026-06-05",
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 1,
            cache_write_tokens: 0,
            reasoning_tokens: 2,
            sessions: 1,
            api_calls: 3,
          },
        ],
        totals: totals({ total_input: 10, total_output: 5, total_tokens: 15, total_sessions: 1, total_api_calls: 3 }),
        comparison: { previous_totals: totals({ total_tokens: 10, total_sessions: 2, total_api_calls: 1 }) },
      }),
      new Date("2026-06-07T12:00:00Z"),
    );

    expect(vm.daily).toHaveLength(7);
    expect(vm.daily.map((item) => item.day)).toContain("2026-06-05");
    expect(vm.daily.find((item) => item.day === "2026-06-05")?.totalTokens).toBe(15);
    expect(vm.kpis.find((item) => item.key === "tokens")?.changePercent).toBe(50);
    expect(vm.kpis.find((item) => item.key === "apiCalls")?.changePercent).toBe(200);
  });

  it("sorts models by token volume and computes token share", () => {
    const vm = buildAnalyticsViewModel(response({
      totals: totals({ total_tokens: 300, total_sessions: 2 }),
      by_model: [
        {
          model: "small",
          provider: "p1",
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          sessions: 1,
          api_calls: 1,
        },
        {
          model: "large",
          provider: "p2",
          input_tokens: 200,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          sessions: 1,
          api_calls: 1,
        },
      ],
    }));

    expect(vm.models[0]?.model).toBe("large");
    expect(vm.models[0]?.share).toBeCloseTo(0.666, 2);
  });

  it("sorts top sessions by tokens then api calls", () => {
    const vm = buildAnalyticsViewModel(response({
      totals: totals({ total_tokens: 500, total_sessions: 2 }),
      top_sessions: [
        {
          session_id: "smaller",
          title: null,
          model: null,
          provider: "p",
          started_at: 1,
          ended_at: null,
          input_tokens: 100,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          api_calls: 10,
        },
        {
          session_id: "larger",
          title: "Large",
          model: "m",
          provider: "p",
          started_at: 2,
          ended_at: null,
          input_tokens: 400,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          reasoning_tokens: 0,
          api_calls: 1,
        },
      ],
    }));

    expect(vm.topSessions[0]?.sessionId).toBe("larger");
    expect(vm.topSessions[1]?.title).toBe("smaller");
  });

  it("marks contract parsing failures with an upgrade message", () => {
    expect(analyticsContractErrorMessage(new Error("Required at top_sessions"))).toContain("合约不匹配");
  });
});
