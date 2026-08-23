import { describe, expect, it } from "vitest";
import { expandWildcard, isWildcard } from "./wildcard.js";
import { ToolsetRegistry } from "./toolset-registry.js";
import { ToolRegistry } from "./tool-registry.js";

describe("isWildcard", () => {
  it("recognizes all and *", () => {
    expect(isWildcard("all")).toBe(true);
    expect(isWildcard("*")).toBe(true);
  });

  it("rejects ordinary toolset names", () => {
    expect(isWildcard("core")).toBe(false);
    expect(isWildcard("all_core")).toBe(false);
    expect(isWildcard("")).toBe(false);
    expect(isWildcard(undefined as unknown as string)).toBe(false);
  });
});

describe("expandWildcard", () => {
  it("delegates to registry.resolveToolset('all')", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    reg.registerMcpToolset("mcp-x", "MCP X", ["mcp__x__t1"]);
    const expanded = expandWildcard(reg);
    expect(expanded).toEqual(reg.resolveToolset("all"));
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded).toContain("todo");
    expect(expanded).toContain("mcp__x__t1");
  });

  it("still expands static toolsets on a fresh registry", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    const expanded = expandWildcard(reg);
    expect(expanded.length).toBeGreaterThan(0);
    expect(expanded).toContain("todo");
    expect(expanded).toContain("file_read");
  });
});
