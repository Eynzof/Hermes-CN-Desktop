import { describe, expect, it } from "vitest";
import { SOUL_CHAR_LIMIT } from "@/hooks/use-soul";
import {
  filterPersonaMarket,
  loadPersonaPrompt,
  personaMarketCategories,
  personaMarketItems,
  personaMarketSource,
} from "./persona-market";

describe("persona market", () => {
  it("内置 215 个有来源且可安全写入 SOUL.md 的中文人格", () => {
    expect(personaMarketItems).toHaveLength(215);
    expect(new Set(personaMarketItems.map((item) => item.id)).size).toBe(215);
    expect(personaMarketCategories.length).toBeGreaterThan(10);
    expect(personaMarketItems.every((item) => item.characterCount <= SOUL_CHAR_LIMIT)).toBe(true);
    expect(personaMarketSource.license).toBe("MIT");
  });

  it("按中文关键词和部门筛选", () => {
    const frontend = filterPersonaMarket("React", "engineering");
    expect(frontend.some((item) => item.id === "engineering-frontend-developer")).toBe(true);
    expect(filterPersonaMarket("React", "finance")).toHaveLength(0);
  });

  it("按需加载中文提示词", async () => {
    const prompt = await loadPersonaPrompt("engineering-frontend-developer");
    expect(prompt).toContain("# 前端开发者 Agent 人格");
    expect(prompt.length).toBeLessThanOrEqual(SOUL_CHAR_LIMIT);
  });
});
