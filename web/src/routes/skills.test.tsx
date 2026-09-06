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
  useCopyBuiltinSkill: () => ({
    error: null,
    isError: false,
    isPending: false,
    mutateAsync: vi.fn(),
    reset: vi.fn(),
  }),
  useSkillMarkdown: () => ({ data: null, isLoading: false }),
}));

vi.mock("@/hooks/use-profiles", () => ({
  useActiveProfileName: () => "default",
  useManagementProfile: () => null,
  useProfiles: () => ({ data: [] }),
  useSetManagementProfile: () => vi.fn(),
}));

import {
  childPath,
  resolveSkillsManagementScope,
  SkillsRoute,
  suggestedSkillCopyName,
} from "./skills";

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
    expect(html).toContain('role="tablist" aria-label="技能页面"');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
  });
});

describe("My Skills actions", () => {
  it("resolves the selected profile's real skills directory", () => {
    expect(childPath("C:\\Users\\mason\\.hermes\\profiles\\reviewer\\", "skills"))
      .toBe("C:\\Users\\mason\\.hermes\\profiles\\reviewer\\skills");
    expect(childPath("/home/mason/.hermes/", "skills"))
      .toBe("/home/mason/.hermes/skills");
  });

  it("suggests a valid unique copy name within the Core limit", () => {
    expect(suggestedSkillCopyName("github-auth", ["github-auth-custom"]))
      .toBe("github-auth-custom-2");
    expect(suggestedSkillCopyName("a".repeat(64), []))
      .toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });
});

describe("Skills management scope", () => {
  it("falls back after the managed Profile disappears from a loaded list", () => {
    expect(resolveSkillsManagementScope("deleted", "default", ["default"], true)).toBeNull();
  });

  it("keeps a valid scope and does not reject it while Profiles are loading", () => {
    expect(resolveSkillsManagementScope("reviewer", "default", ["default", "reviewer"], true))
      .toBe("reviewer");
    expect(resolveSkillsManagementScope("reviewer", "default", [], false)).toBe("reviewer");
  });
});
