import { describe, expect, it } from "vitest";
import { ToolRegistry, ToolsetRegistry, expandWildcard, isWildcard, mcpToolName, sanitizeMcpToolName } from "./index.js";

describe("ToolRegistry", () => {
  it("registers and retrieves tools", () => {
    const reg = new ToolRegistry();
    reg.register({ name: "foo", toolset: "test", description: "", schema: {}, handler: async () => ({ content: "" }) });
    expect(reg.getEntry("foo")?.name).toBe("foo");
    expect(reg.getRegisteredToolsetNames()).toContain("test");
  });

  it("respects override flag", () => {
    const reg = new ToolRegistry();
    reg.register({ name: "foo", toolset: "test", description: "", schema: {}, handler: async () => ({ content: "" }) });
    expect(() =>
      reg.register({ name: "foo", toolset: "test", description: "", schema: {}, handler: async () => ({ content: "" }) }),
    ).toThrow();
    reg.register(
      { name: "foo", toolset: "test", description: "", schema: {}, handler: async () => ({ content: "" }) },
      { override: true },
    );
    expect(reg.getEntry("foo")).toBeDefined();
  });

  it("supports toolset aliases", () => {
    const reg = new ToolRegistry();
    reg.registerToolsetAlias("github", "mcp-github");
    expect(reg.getToolsetAliasTarget("github")).toBe("mcp-github");
  });
});

describe("ToolsetRegistry", () => {
  it("resolves static toolsets", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    expect(reg.resolveToolset("core")).toContain("todo");
  });

  it("resolves custom toolsets", () => {
    const treg = new ToolRegistry();
    const reg = new ToolsetRegistry(treg);
    reg.createCustomToolset("mine", "My toolset", ["my_tool"], ["core"]);
    const resolved = reg.resolveToolset("mine");
    expect(resolved).toContain("my_tool");
    expect(resolved).toContain("todo");
  });

  it("expands wildcards", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    const all = expandWildcard(reg);
    expect(all.length).toBeGreaterThan(0);
    expect(isWildcard("all")).toBe(true);
  });
});

describe("MCP naming", () => {
  it("sanitizes tool names", () => {
    expect(sanitizeMcpToolName("read-file")).toBe("read-file");
    expect(sanitizeMcpToolName("read file!")).toBe("read_file_");
  });

  it("builds qualified mcp tool names", () => {
    expect(mcpToolName("github", "star")).toBe("mcp__github__star");
  });
});
