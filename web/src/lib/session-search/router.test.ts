import { describe, expect, it } from "vitest";
import { buildSessionIdSearchSql, routeSearchQuery } from "./router";

describe("routeSearchQuery", () => {
  it("routes non-CJK queries to unicode61", () => {
    const { route, params } = routeSearchQuery("hello world", { limit: 10 });
    expect(route.strategy).toBe("unicode61");
    expect(route.ftsQuery).toContain("hello*");
    expect(params[0]).toContain("hello*");
  });

  it("routes CJK with lone run to LIKE fallback", () => {
    const { route } = routeSearchQuery("人 工智能", { limit: 10 });
    expect(route.strategy).toBe("like");
    expect(route.likeQuery).toBeDefined();
  });

  it("routes CJK bigram-eligible queries to messages_fts_cjk", () => {
    const { route } = routeSearchQuery("人工智能", { limit: 10 });
    expect(route.strategy).toBe("cjk_bigram");
    expect(route.bigrammedQuery).toContain("\u0001");
  });

  it("routes all-3+ char CJK runs to bigram (trigram is the fallback when bigram is disabled)", () => {
    const { route } = routeSearchQuery("人工智能助手", { limit: 10 });
    expect(route.strategy).toBe("cjk_bigram");
  });

  it("includes snippet and filters in SQL", () => {
    const { sql } = routeSearchQuery("test", {
      includeSnippet: true,
      sourceFilter: ["chat"],
      excludeSources: ["tool"],
      roleFilter: "user",
      limit: 5,
    });
    expect(sql).toContain("snippet");
    expect(sql).toContain("messages_fts");
    expect(sql).toContain("s.source IN");
    expect(sql).toContain("s.source NOT IN");
    expect(sql).toContain("m.role = ?");
  });

  it("supports sort order", () => {
    const { sql } = routeSearchQuery("test", { sort: "newest" });
    expect(sql).toContain("ORDER BY m.timestamp DESC");
  });
});

describe("buildSessionIdSearchSql", () => {
  it("builds exact/prefix bounded search", () => {
    const { sql, params } = buildSessionIdSearchSql("sess-123", 20);
    expect(sql).toContain("id = ?");
    expect(sql).toContain("id LIKE ?");
    expect(params).toEqual(["sess-123", "sess-123%", 20]);
  });
});
