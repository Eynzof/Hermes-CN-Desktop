import { describe, expect, it } from "vitest";
import {
  buildLikeBooleanQuery,
  buildPrefixWildcardQuery,
  escapeLike,
  sanitizeFts5Query,
} from "./fts-query";

describe("sanitizeFts5Query", () => {
  it("strips FTS5-special characters but preserves balanced quotes", () => {
    expect(sanitizeFts5Query('hello "world" ^test')).toBe('hello "world" test');
  });

  it("caps at 2048 characters", () => {
    const long = "a".repeat(3000);
    expect(sanitizeFts5Query(long).length).toBe(2048);
  });

  it("preserves balanced double quotes as phrase", () => {
    expect(sanitizeFts5Query('"artificial intelligence"')).toBe('"artificial intelligence"');
  });

  it("wraps hyphen terms by removing hyphen", () => {
    expect(sanitizeFts5Query("state-of-the-art")).toBe("state of the art");
  });

  it("collapses whitespace", () => {
    expect(sanitizeFts5Query("hello\n\tworld")).toBe("hello world");
  });
});

describe("buildPrefixWildcardQuery", () => {
  it("adds prefix wildcard to tokens", () => {
    expect(buildPrefixWildcardQuery("hello world")).toBe("hello* world*");
  });

  it("leaves quoted phrases untouched", () => {
    expect(buildPrefixWildcardQuery('"hello world"')).toBe('"hello world"');
  });

  it("adds wildcard only to unquoted tokens", () => {
    expect(buildPrefixWildcardQuery('foo "bar baz" qux')).toBe('foo* "bar baz" qux*');
  });
});

describe("buildLikeBooleanQuery", () => {
  it("ANDs tokens by default", () => {
    expect(buildLikeBooleanQuery("hello world")).toEqual({
      pattern: "%hello% AND %world%",
      negated: false,
    });
  });

  it("ORs tokens when OR is present", () => {
    expect(buildLikeBooleanQuery("hello OR world")).toEqual({
      pattern: "%hello% OR %world%",
      negated: false,
    });
  });

  it("returns wildcard for empty query", () => {
    expect(buildLikeBooleanQuery("   ")).toEqual({
      pattern: "%",
      negated: false,
    });
  });
});

describe("escapeLike", () => {
  it("escapes % and _", () => {
    expect(escapeLike("100%")).toBe("100\\%");
    expect(escapeLike("_test")).toBe("\\_test");
  });
});
