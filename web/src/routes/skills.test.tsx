import ReactDOMServer from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-skills", () => ({
  useSkills: () => ({
    data: [],
    error: null,
    isError: false,
    isFetching: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useToggleSkill: () => ({ mutate: vi.fn(), isPending: false }),
  useSkillMarkdown: () => ({ data: null, isLoading: false }),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
  useManagementProfile: () => null,
  useProfiles: () => ({ data: [] }),
  useSetManagementProfile: () => vi.fn(),
}));

vi.mock("@/components/top-bar/top-bar", () => ({
  TopBarActions: () => null,
}));

import { SkillsRoute } from "./skills";

describe("SkillsRoute tabs", () => {
  it("places statistics between Skill market and My Skills", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <MemoryRouter><SkillsRoute /></MemoryRouter>,
    );

    const market = html.indexOf("Skill 市场");
    const stats = html.indexOf(">统计<");
    const mine = html.indexOf("我的 Skills");
    expect(market).toBeGreaterThan(-1);
    expect(stats).toBeGreaterThan(market);
    expect(mine).toBeGreaterThan(stats);
  });
});
