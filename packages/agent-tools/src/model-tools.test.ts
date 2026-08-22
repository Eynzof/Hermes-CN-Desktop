import { describe, it, expect, beforeEach } from "vitest";
import { getToolDefinitions, clearToolDefinitionsMemo, toolDefinitionsMemoSize } from "./model-tools.js";
import { registry } from "./registry.js";
import type { ToolEntry } from "./types.js";

const noopEntry: ToolEntry = {
  name: "noop",
  toolset: "core",
  schema: { type: "object", properties: {} },
  handler: async () => ({ content: "ok" }),
};

describe("getToolDefinitions", () => {
  beforeEach(() => {
    clearToolDefinitionsMemo();
  });

  it("resolves core toolset into definitions", async () => {
    const defs = await getToolDefinitions(["core"], []);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain("todo");
    expect(names).toContain("clarify");
  });

  it("subtracts disabled toolsets", async () => {
    const defs = await getToolDefinitions(["hermes_cli"], ["web"]);
    const names = defs.map((d) => d.function.name);
    expect(names).toContain("todo");
    expect(names).not.toContain("web_search");
  });

  it("memoizes repeated calls", async () => {
    await getToolDefinitions(["core"], []);
    await getToolDefinitions(["core"], []);
    expect(toolDefinitionsMemoSize()).toBe(1);
  });

  it("invalidates memo on registry generation change", async () => {
    await getToolDefinitions(["core"], []);
    registry.register(noopEntry);
    await getToolDefinitions(["core", "noop"], []);
    expect(toolDefinitionsMemoSize()).toBe(2);
  });

  it("quiet mode shortens descriptions", async () => {
    const defs = await getToolDefinitions(["core"], [], { quiet: true });
    expect(defs.every((d) => d.function.description === `${d.function.name} tool`)).toBe(true);
  });

  it("kanban stays gated under all", async () => {
    const defs = await getToolDefinitions(["all"], []);
    const names = defs.map((d) => d.function.name);
    expect(names).not.toContain("kanban_create_board");
  });
});
