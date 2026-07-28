import ReactDOMServer from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-analytics", () => ({
  useAnalytics: () => ({
    data: {
      period_days: 30,
      skills: {
        summary: {
          total_skill_loads: 12,
          total_skill_edits: 2,
          total_skill_actions: 14,
          distinct_skills_used: 2,
        },
        top_skills: [
          {
            skill: "hermes-agent",
            view_count: 9,
            manage_count: 1,
            total_count: 10,
            percentage: 71.4,
            last_used_at: 1_700_000_000,
          },
          {
            skill: "github-pr-workflow",
            view_count: 3,
            manage_count: 1,
            total_count: 4,
            percentage: 28.6,
            last_used_at: null,
          },
        ],
      },
    },
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
}));

import { buildSkillUsageRows, SkillUsageStats } from "./skill-usage-stats";

describe("SkillUsageStats", () => {
  it("renders invocation-focused summary and ranking", () => {
    const html = ReactDOMServer.renderToStaticMarkup(<SkillUsageStats />);

    expect(html).toContain("Skill 调用统计");
    expect(html).toContain("调用总数");
    expect(html).toContain(">12<");
    expect(html).toContain("Hermes Agent 自身");
    expect(html).toContain("75.0%");
    expect(html).toContain("编辑操作");
  });

  it("sorts by invocation count and recomputes invocation share", () => {
    const rows = buildSkillUsageRows([
      { skill: "edited", view_count: 1, manage_count: 20, total_count: 21, percentage: 70, last_used_at: null },
      { skill: "called", view_count: 3, manage_count: 0, total_count: 3, percentage: 10, last_used_at: null },
    ], 4);

    expect(rows.map((row) => row.skill)).toEqual(["called", "edited"]);
    expect(rows[0]?.invocationShare).toBe(0.75);
  });
});
