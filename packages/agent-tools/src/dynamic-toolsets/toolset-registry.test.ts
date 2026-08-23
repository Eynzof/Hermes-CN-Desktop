import { describe, expect, it } from "vitest";
import { ToolsetRegistry, resolveToolset } from "./toolset-registry.js";
import { ToolRegistry } from "./tool-registry.js";

function makeRegistry(): ToolsetRegistry {
  return new ToolsetRegistry(new ToolRegistry());
}

describe("ToolsetRegistry.getToolset", () => {
  it("returns static toolset definitions", () => {
    const reg = makeRegistry();
    const def = reg.getToolset("core");
    expect(def).toBeDefined();
    expect(def!.tools).toContain("todo");
    expect(def!.includes).toEqual([]);
  });

  it("returns custom toolset definitions regardless of includeRegistry", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("mine", "My toolset", ["t1"], ["core"]);
    expect(reg.getToolset("mine", { includeRegistry: false })?.tools).toEqual(["t1"]);
  });

  it("returns mcp/plugin toolset definitions only when includeRegistry is true", () => {
    const reg = makeRegistry();
    reg.registerMcpToolset("mcp-x", "MCP X", ["mcp__x__t1"]);
    reg.registerPluginToolset("plug-y", "Plugin Y", ["plug_y_t1"]);
    expect(reg.getToolset("mcp-x")?.tools).toEqual(["mcp__x__t1"]);
    expect(reg.getToolset("plug-y")?.tools).toEqual(["plug_y_t1"]);
    expect(reg.getToolset("mcp-x", { includeRegistry: false })).toBeUndefined();
    expect(reg.getToolset("plug-y", { includeRegistry: false })).toBeUndefined();
  });

  it("resolves alias names to their canonical toolset", () => {
    const treg = new ToolRegistry();
    const reg = new ToolsetRegistry(treg);
    treg.registerToolsetAlias("github", "mcp-github");
    reg.registerMcpToolset("mcp-github", "GitHub MCP", ["mcp__github__star"]);
    const def = reg.getToolset("github");
    expect(def?.tools).toEqual(["mcp__github__star"]);
  });

  it("synthesizes a dynamic toolset from registered tools", () => {
    const treg = new ToolRegistry();
    const reg = new ToolsetRegistry(treg);
    treg.register({
      name: "custom_1",
      toolset: "mystery",
      description: "",
      schema: {},
      handler: async () => ({ content: "" }),
    });
    const def = reg.getToolset("mystery");
    expect(def?.tools).toEqual(["custom_1"]);
    expect(def?.description).toBe("Dynamic toolset mystery");
    expect(reg.getToolset("mystery", { includeRegistry: false })).toBeUndefined();
  });

  it("returns undefined for unknown toolsets", () => {
    expect(makeRegistry().getToolset("nope")).toBeUndefined();
  });
});

describe("ToolsetRegistry.resolveToolset", () => {
  it("resolves a static leaf toolset", () => {
    const tools = makeRegistry().resolveToolset("core");
    expect(tools).toEqual(["clarify", "complete", "delegate_task", "think", "todo"]);
  });

  it("resolves composite toolsets recursively with dedupe", () => {
    const tools = makeRegistry().resolveToolset("coding");
    // coding = core + file + terminal + code_execution (+ file via code_execution)
    expect(tools).toContain("todo");
    expect(tools).toContain("file_read");
    expect(tools).toContain("terminal_run");
    expect(tools).toContain("execute_code");
    // No duplicates after merging.
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("resolves custom toolset includes recursively", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("mine", "My toolset", ["my_tool"], ["core"]);
    const tools = reg.resolveToolset("mine");
    expect(tools).toContain("my_tool");
    expect(tools).toContain("todo");
  });

  it("is cycle-safe for diamond/self-referential includes", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("a", "A", [], ["b"]);
    reg.createCustomToolset("b", "B", ["b_tool"], ["a"]);
    const tools = reg.resolveToolset("a");
    expect(tools).toContain("b_tool");
    expect(new Set(tools).size).toBe(tools.length);
  });

  it("returns an empty array for unknown toolsets", () => {
    expect(makeRegistry().resolveToolset("nope")).toEqual([]);
  });

  it("expands the all/* wildcard across every known toolset", () => {
    const reg = makeRegistry();
    reg.registerMcpToolset("mcp-x", "MCP X", ["mcp__x__t1"]);
    const all = reg.resolveToolset("all");
    const star = reg.resolveToolset("*");
    expect(all.length).toBeGreaterThan(0);
    expect(all).toEqual(star);
    expect(all).toContain("todo");
    expect(all).toContain("mcp__x__t1");
    // Kanban is included in the registry wildcard expansion (documented behavior).
    expect(all).toContain("kanban_create_board");
  });
});

describe("ToolsetRegistry.resolveMultipleToolsets", () => {
  it("merges several toolsets and sorts the result", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("mine", "My toolset", ["zz_tool"], []);
    const tools = reg.resolveMultipleToolsets(["core", "mine"]);
    expect(tools).toEqual(["clarify", "complete", "delegate_task", "think", "todo", "zz_tool"]);
  });

  it("subtracts disabled toolsets", () => {
    const reg = makeRegistry();
    const tools = reg.resolveMultipleToolsets(["core", "file"], ["file"]);
    expect(tools).toEqual(["clarify", "complete", "delegate_task", "think", "todo"]);
    expect(tools).not.toContain("file_read");
  });
});

describe("ToolsetRegistry listing and validation", () => {
  it("getAllToolsets merges static, custom, mcp and plugin defs", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("c", "C", [], []);
    reg.registerMcpToolset("m", "M", []);
    reg.registerPluginToolset("p", "P", []);
    const all = reg.getAllToolsets();
    expect(all.get("core")).toBeDefined();
    expect(all.get("c")).toBeDefined();
    expect(all.get("m")).toBeDefined();
    expect(all.get("p")).toBeDefined();
    expect(all.size).toBeGreaterThan(3);
  });

  it("getToolsetNames is sorted", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("zeta", "Z", [], []);
    reg.createCustomToolset("alpha", "A", [], []);
    const names = reg.getToolsetNames();
    expect(names).toEqual([...names].sort());
    expect(names).toContain("alpha");
    expect(names).toContain("zeta");
  });

  it("validate accepts known, custom, mcp, and wildcard names", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("mine", "My toolset", [], []);
    reg.registerMcpToolset("mcp-x", "MCP X", []);
    expect(reg.validate("core")).toBe(true);
    expect(reg.validate("mine")).toBe(true);
    expect(reg.validate("mcp-x")).toBe(true);
    expect(reg.validate("all")).toBe(true);
    expect(reg.validate("*")).toBe(true);
    expect(reg.validate("nope")).toBe(false);
  });

  it("createCustomToolset / upsertCustomToolset store definitions", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("a", "A", ["t1"], ["core"]);
    expect(reg.getToolset("a")?.tools).toEqual(["t1"]);
    reg.upsertCustomToolset({ name: "a", description: "A2", tools: ["t2"], includes: [] });
    const def = reg.getToolset("a");
    expect(def?.description).toBe("A2");
    expect(def?.tools).toEqual(["t2"]);
    expect(def?.includes).toEqual([]);
  });

  it("registerMcpToolset and registerPluginToolset store toolsets", () => {
    const reg = makeRegistry();
    reg.registerMcpToolset("srv", "Server", ["mcp__srv__t"]);
    reg.registerPluginToolset("plug", "Plugin", ["plug_t"]);
    expect(reg.getToolset("srv")?.tools).toEqual(["mcp__srv__t"]);
    expect(reg.getToolset("plug")?.tools).toEqual(["plug_t"]);
  });
});

describe("ToolsetRegistry.getToolsetInfo", () => {
  it("reports composite vs leaf structure", () => {
    const reg = makeRegistry();
    reg.createCustomToolset("composite", "Composite", ["t1"], ["core"]);
    reg.createCustomToolset("leaf", "Leaf", ["t2"], []);
    const composite = reg.getToolsetInfo("composite");
    expect(composite?.directTools).toEqual(["t1"]);
    expect(composite?.includes).toEqual(["core"]);
    expect(composite?.resolvedTools).toContain("todo");
    expect(composite?.toolCount).toBe(composite!.resolvedTools.length);
    expect(composite?.isComposite).toBe(true);
    expect(reg.getToolsetInfo("leaf")?.isComposite).toBe(false);
    expect(reg.getToolsetInfo("nope")).toBeUndefined();
  });
});

describe("resolveToolset wrapper (static fallback)", () => {
  it("delegates to the static resolver", () => {
    const result = resolveToolset("core");
    expect(result).toBeInstanceOf(Set);
    expect(result.has("todo")).toBe(true);
  });

  it("passes custom toolsets through to the static resolver", () => {
    const result = resolveToolset("mine", {
      customToolsets: { mine: { name: "mine", description: "", tools: ["t1"], includes: ["core"] } },
    });
    expect(result.has("t1")).toBe(true);
    expect(result.has("todo")).toBe(true);
  });
});
