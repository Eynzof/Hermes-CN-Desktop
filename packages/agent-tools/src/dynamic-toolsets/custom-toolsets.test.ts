import { describe, expect, it } from "vitest";
import { loadCustomToolsets, customToolsetToDefinition } from "./custom-toolsets.js";
import { ToolRegistry } from "./tool-registry.js";
import { ToolsetRegistry } from "./toolset-registry.js";

describe("loadCustomToolsets", () => {
  it("treats array values as the includes shorthand", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    loadCustomToolsets({ work: ["core", "file"] }, reg);
    const def = reg.getToolset("work");
    expect(def).toBeDefined();
    expect(def!.tools).toEqual([]);
    expect(def!.includes).toEqual(["core", "file"]);
    expect(def!.description).toBe("Custom toolset work");
  });

  it("treats object values as { tools, includes }", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    loadCustomToolsets({ mine: { tools: ["my_tool"], includes: ["web"] } }, reg);
    const def = reg.getToolset("mine");
    expect(def!.tools).toEqual(["my_tool"]);
    expect(def!.includes).toEqual(["web"]);
  });

  it("defaults missing tools/includes to empty arrays", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    loadCustomToolsets({ empty: {} }, reg);
    expect(reg.getToolset("empty")).toEqual({ description: "Custom toolset empty", tools: [], includes: [] });
  });

  it("is a no-op for an empty config", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    const before = reg.getAllToolsets().size;
    loadCustomToolsets({}, reg);
    expect(reg.getAllToolsets().size).toBe(before);
  });

  it("does not throw for null-ish values passed as arrays", () => {
    const reg = new ToolsetRegistry(new ToolRegistry());
    expect(() => loadCustomToolsets({ weird: [] as unknown as string[] }, reg)).not.toThrow();
  });
});

describe("customToolsetToDefinition", () => {
  it("maps array form to includes with empty tools", () => {
    expect(customToolsetToDefinition(["a", "b"])).toEqual({
      name: "",
      description: "",
      tools: [],
      includes: ["a", "b"],
    });
  });

  it("maps object form preserving tools and includes", () => {
    expect(customToolsetToDefinition({ tools: ["t1"], includes: ["i1"] })).toEqual({
      name: "",
      description: "",
      tools: ["t1"],
      includes: ["i1"],
    });
  });

  it("defaults missing fields on object form", () => {
    expect(customToolsetToDefinition({})).toEqual({
      name: "",
      description: "",
      tools: [],
      includes: [],
    });
  });
});
